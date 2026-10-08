import process from 'node:process';

import type {
    ServerEvent,
    SessionRecord,
    TerminalProcessEntry,
    TerminalRecord,
    TerminalResourceAlert,
} from '@caxri/protocol';
import { errorMessage, isTerminalResourceUsageHigh } from '@caxri/protocol';
import type { ProcessTable, ProcessTreeUsage, StructuredLogger } from '@caxri/system';
import { logEventCatalog, sampleProcessTable } from '@caxri/system';

import type { WatchHandle, WatchHub } from '../watch-hub';
import type {
    E2ETerminalResourceOverride,
    TerminalResourceReadingOverride,
} from './e2e-resource-override';
import {
    applyTerminalResourceOverride,
    resolveE2ETerminalResourceOverride,
} from './e2e-resource-override';
import type { TerminalManager } from './manager';

const TERMINAL_RESOURCE_SAMPLE_INTERVAL_MS = 10_000;
/**
 * Consecutive high samples before an alert. `ps` CPU is already a decaying average, and memory rarely spikes for a
 * single sample, so two readings (≈10–20 s) filter out a transient build burst without delaying a real runaway long.
 */
const HIGH_SAMPLES_BEFORE_ALERT = 2;
const MAX_TITLE_LENGTH = 512;

interface TerminalResourceMonitorOptions {
    database: {
        getSession(id: string): SessionRecord | undefined;
        listTerminals(): TerminalRecord[];
    };
    intervalMs?: number;
    logger: StructuredLogger;
    now?: () => number;
    sampleProcessTable?: () => Promise<ProcessTable>;
    send: (event: ServerEvent) => void;
    terminals: Pick<TerminalManager, 'processId'>;
    /**
     * E2E-only injected readings and sample cadence; see `e2e-resource-override.ts`. Defaults to the seam resolved from
     * the process environment, which is absent outside an explicit E2E launch.
     */
    usageOverride?: E2ETerminalResourceOverride;
    watchHub: Pick<WatchHub, 'registerPoller'>;
}

interface AlertState {
    alertedAt?: number;
    entry: TerminalProcessEntry;
    highSamples: number;
    lastUsage?: ProcessTreeUsage;
    /**
     * Highest reading during the alerted episode, reported when it clears so the log measures how bad it got.
     */
    peak?: ProcessTreeUsage;
}

/**
 * Watches every running Terminal's process tree and tells clients when one keeps using too much memory or CPU.
 *
 * One `ps` call per sample covers every Terminal, and nothing runs while no Terminal is alive. An episode alerts once:
 * `raised` after {@link HIGH_SAMPLES_BEFORE_ALERT} high samples in a row, `cleared` when the tree falls back below the
 * thresholds or the Terminal stops running, which re-arms it.
 */
export class TerminalResourceMonitor {
    private poller?: WatchHandle;
    private readonly states = new Map<string, AlertState>();
    private readonly usageOverride: E2ETerminalResourceOverride | undefined;

    constructor(private readonly options: TerminalResourceMonitorOptions) {
        this.usageOverride =
            options.usageOverride ?? resolveE2ETerminalResourceOverride(process.env);
    }

    private raise(state: AlertState, usage: ProcessTreeUsage): void {
        state.alertedAt = this.now();
        this.options.logger.write('warn', logEventCatalog.terminal.resourceAlertRaised, {
            fields: {
                cpuPercent: usage.cpuPercent,
                memoryMb: usage.memoryMb,
                processCount: usage.processCount,
                provider: state.entry.provider ?? 'shell',
                sessionId: state.entry.sessionId,
                terminalId: state.entry.terminalId,
            },
        });
        this.publish({ state: 'raised', terminal: state.entry, ...usage });
    }

    private clear(
        state: AlertState,
        usage: ProcessTreeUsage | undefined,
        reason: 'recovered' | 'stopped',
    ): void {
        this.options.logger.write('info', logEventCatalog.terminal.resourceAlertCleared, {
            durationMs: this.now() - (state.alertedAt ?? this.now()),
            fields: {
                peakCpuPercent: state.peak?.cpuPercent ?? 0,
                peakMemoryMb: state.peak?.memoryMb ?? 0,
                reason,
                terminalId: state.entry.terminalId,
            },
        });
        this.publish({
            state: 'cleared',
            terminal: state.entry,
            ...(usage ?? state.lastUsage ?? { cpuPercent: 0, memoryMb: 0, processCount: 0 }),
        });
    }

    private publish(alert: TerminalResourceAlert): void {
        this.options.send({ event: 'terminal.resourceAlert', payload: alert });
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    /**
     * The injected reading for one Terminal, so the `terminal.resources` status bar query and this monitor's alert are
     * driven by the same value. Always `undefined` outside an explicit E2E launch.
     */
    readingOverride(terminalId: string): Promise<TerminalResourceReadingOverride | undefined> {
        return this.usageOverride?.read(terminalId) ?? Promise.resolve(undefined);
    }

    /**
     * The running Terminals with their PTY root PIDs, for a process inspector to group OS processes by Session.
     */
    processes(): TerminalProcessEntry[] {
        return this.options.database.listTerminals().flatMap((terminal) => {
            const processId = this.options.terminals.processId(terminal.id);
            if (processId === undefined) return [];
            const session = this.options.database.getSession(terminal.sessionId);
            return [
                {
                    terminalId: terminal.id,
                    sessionId: terminal.sessionId,
                    sessionTitle: (session?.displayTitle ?? '').slice(0, MAX_TITLE_LENGTH),
                    kind: terminal.kind,
                    provider: terminal.provider,
                    title: terminal.title.slice(0, MAX_TITLE_LENGTH),
                    processId,
                },
            ];
        });
    }

    start(): void {
        this.poller = this.options.watchHub.registerPoller({
            intervalMs:
                this.options.intervalMs ??
                this.usageOverride?.intervalMs ??
                TERMINAL_RESOURCE_SAMPLE_INTERVAL_MS,
            label: 'terminal-resource-monitor',
            pollOnce: () => this.sample(),
        });
    }

    async sample(): Promise<void> {
        const running = this.processes();
        if (running.length === 0 && this.states.size === 0) return;
        let table: ProcessTable;
        try {
            table = await (this.options.sampleProcessTable ?? sampleProcessTable)();
        } catch (error) {
            this.options.logger.write('warn', logEventCatalog.terminal.resourceSampleFailed, {
                fields: { error: errorMessage(error, 'unknown'), terminals: running.length },
            });
            return;
        }
        const { usageOverride } = this;
        const overrides = usageOverride
            ? await Promise.all(running.map((entry) => usageOverride.read(entry.terminalId)))
            : [];
        const seen = new Set<string>();
        for (const [index, entry] of running.entries()) {
            seen.add(entry.terminalId);
            const usage = applyTerminalResourceOverride(
                table.usage(entry.processId),
                overrides[index],
            );
            const state = this.states.get(entry.terminalId) ?? { entry, highSamples: 0 };
            state.entry = entry;
            if (usage && isTerminalResourceUsageHigh(usage)) {
                state.highSamples += 1;
                state.lastUsage = usage;
                state.peak = state.peak
                    ? {
                          cpuPercent: Math.max(state.peak.cpuPercent, usage.cpuPercent),
                          memoryMb: Math.max(state.peak.memoryMb, usage.memoryMb),
                          processCount: Math.max(state.peak.processCount, usage.processCount),
                      }
                    : usage;
                this.states.set(entry.terminalId, state);
                if (state.alertedAt === undefined && state.highSamples >= HIGH_SAMPLES_BEFORE_ALERT)
                    this.raise(state, usage);
                continue;
            }
            if (state.alertedAt !== undefined) this.clear(state, usage ?? undefined, 'recovered');
            this.states.delete(entry.terminalId);
        }
        for (const [terminalId, state] of this.states) {
            if (seen.has(terminalId)) continue;
            if (state.alertedAt !== undefined) this.clear(state, undefined, 'stopped');
            this.states.delete(terminalId);
        }
    }

    async close(): Promise<void> {
        await this.poller?.dispose();
        this.poller = undefined;
    }
}
