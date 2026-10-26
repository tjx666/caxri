import os from 'node:os';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import type {
    HostSessionLoadSample,
    HostStatusSample,
    MobileHostProcess,
    MobileHostService,
    MobileHostStatus,
    MobileHostSystem,
    TerminalProcessEntry,
} from '@caxri/protocol';
import { errorMessage, projectHostStatusForMobile } from '@caxri/protocol';
import type { ProcessTable, StructuredLogger, SystemMemory } from '@caxri/system';
import {
    CpuUsageMeter,
    logEventCatalog,
    sampleProcessTable,
    sampleSystemMemory,
    serverHostRole,
} from '@caxri/system';
import { processDisplayName } from '@caxri/utils';

/**
 * Several paired phones may poll at once; within this window they share one sample instead of each running `ps`.
 */
const SHARED_SAMPLE_MS = 1_000;
/**
 * A CPU reading needs two counter samples. When the previous one is this old (nobody has looked for a while), the
 * sampler takes a short fresh pair instead of reporting the average since that stale read.
 */
const CPU_BASELINE_MAX_AGE_MS = 10_000;
const CPU_BASELINE_GAP_MS = 300;

type SamplePart = 'processTable' | 'terminals';

interface HostStatusSamplerOptions {
    logger?: Pick<StructuredLogger, 'write'>;
    now?: () => number;
    /**
     * Running Terminals with their PTY root PIDs (`terminal.processes`).
     */
    terminals: () => Promise<TerminalProcessEntry[]>;
    cpuMeter?: CpuUsageMeter;
    cpuBaselineGapMs?: number;
    sampleProcessTable?: () => Promise<ProcessTable>;
    sampleSystemMemory?: () => Promise<SystemMemory>;
    serverPid?: number;
    system?: () => Pick<MobileHostSystem, 'cpuCount' | 'loadAverage' | 'uptimeSeconds'>;
}

const round = (value: number): number => Math.round(value * 10) / 10;

const readSystem = (): Pick<MobileHostSystem, 'cpuCount' | 'loadAverage' | 'uptimeSeconds'> => {
    const [one = 0, five = 0, fifteen = 0] = os.loadavg();
    return {
        cpuCount: Math.max(1, os.availableParallelism()),
        loadAverage: [round(one), round(five), round(fifteen)],
        uptimeSeconds: Math.round(os.uptime()),
    };
};

/**
 * Sums each running Terminal's process tree into its Session, the per-session PTY descendant sum Orca, Superset, and
 * cmux show. A Terminal whose PTY already exited is left out.
 */
export function sessionLoads(
    table: ProcessTable,
    terminals: readonly TerminalProcessEntry[],
): HostSessionLoadSample[] {
    const sessions = new Map<string, HostSessionLoadSample>();
    for (const terminal of terminals) {
        const usage = table.usage(terminal.processId);
        if (!usage) continue;
        const session = sessions.get(terminal.sessionId) ?? {
            sessionId: terminal.sessionId,
            title: terminal.sessionTitle,
            cpuPercent: 0,
            memoryMb: 0,
            processCount: 0,
            terminals: [],
        };
        session.cpuPercent = round(session.cpuPercent + usage.cpuPercent);
        session.memoryMb = round(session.memoryMb + usage.memoryMb);
        session.processCount += usage.processCount;
        session.terminals.push({
            terminalId: terminal.terminalId,
            kind: terminal.kind,
            ...(terminal.provider && { provider: terminal.provider }),
            title: terminal.title,
            ...usage,
        });
        sessions.set(terminal.sessionId, session);
    }
    return sessions.values().toArray();
}

const megabytes = (rssKb: number): number => Math.round((rssKb / 1024) * 10) / 10;

/**
 * Server Core itself and its Terminal and Extension Hosts, each by its own process only: the Terminal Host's
 * descendants are the Terminals, which the Session list already counts.
 */
export function serviceLoads(table: ProcessTable, serverPid: number): MobileHostService[] {
    const services: MobileHostService[] = [];
    const server = table.get(serverPid);
    if (server)
        services.push({
            role: 'serverCore',
            pid: server.pid,
            cpuPercent: server.cpuPercent,
            memoryMb: megabytes(server.rssKb),
        });
    for (const entry of table.entries()) {
        if (entry.parentPid !== serverPid) continue;
        const role = serverHostRole(entry.command ?? '');
        if (role)
            services.push({
                role,
                pid: entry.pid,
                cpuPercent: entry.cpuPercent,
                memoryMb: megabytes(entry.rssKb),
            });
    }
    return services;
}

/**
 * Every process reduced to its display name. The command line itself never leaves this function. The `ps` that took the
 * sample is dropped.
 */
export function namedProcesses(table: ProcessTable): MobileHostProcess[] {
    return table.entries().flatMap((entry) => {
        const command = entry.command ?? '';
        if (command.startsWith('/bin/ps -axo')) return [];
        const name = processDisplayName(command);
        if (!name) return [];
        return [
            {
                pid: entry.pid,
                name,
                cpuPercent: entry.cpuPercent,
                memoryMb: megabytes(entry.rssKb),
            },
        ];
    });
}

/**
 * Samples the Mac for a paired phone's computer status: system CPU and memory, Caxri's services, each Session's load,
 * and the busiest processes. Lazy: nothing runs until a phone asks, and concurrent phones share one sample.
 */
export class HostStatusSampler {
    private readonly cpuMeter: CpuUsageMeter;
    private cpuReadAt = -Infinity;
    private inFlight?: Promise<MobileHostStatus>;
    private latest?: { at: number; status: MobileHostStatus };
    private readonly failing = new Set<SamplePart>();

    constructor(private readonly options: HostStatusSamplerOptions) {
        this.cpuMeter = options.cpuMeter ?? new CpuUsageMeter();
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    private async readCpu(): Promise<number | undefined> {
        const isStale = this.now() - this.cpuReadAt > CPU_BASELINE_MAX_AGE_MS;
        if (isStale) {
            this.cpuMeter.sample();
            await delay(this.options.cpuBaselineGapMs ?? CPU_BASELINE_GAP_MS);
        }
        this.cpuReadAt = this.now();
        return this.cpuMeter.sample();
    }

    /**
     * Logs a part's failure once when it starts failing, not on every phone poll, and re-arms once it succeeds again.
     */
    private record(part: SamplePart, error?: unknown): void {
        if (error === undefined) {
            this.failing.delete(part);
            return;
        }
        if (this.failing.has(part)) return;
        this.failing.add(part);
        this.options.logger?.write('warn', logEventCatalog.mobileGateway.hostStatusSampleFailed, {
            fields: { part, error: errorMessage(error, 'unknown') },
        });
    }

    private async readTerminals(): Promise<TerminalProcessEntry[]> {
        try {
            const terminals = await this.options.terminals();
            this.record('terminals');
            return terminals;
        } catch (error) {
            this.record('terminals', error);
            return [];
        }
    }

    private async readProcesses(): Promise<HostStatusSample['processes']> {
        const terminals = this.readTerminals();
        let table: ProcessTable;
        try {
            table = await (
                this.options.sampleProcessTable ??
                (() => sampleProcessTable({ includeCommand: true }))
            )();
            this.record('processTable');
        } catch (error) {
            this.record('processTable', error);
            await terminals;
            return;
        }
        return {
            services: serviceLoads(table, this.options.serverPid ?? process.pid),
            sessions: sessionLoads(table, await terminals),
            all: namedProcesses(table),
        };
    }

    private async load(): Promise<MobileHostStatus> {
        const [cpuPercent, memory, processes] = await Promise.all([
            this.readCpu(),
            (this.options.sampleSystemMemory ?? sampleSystemMemory)(),
            this.readProcesses(),
        ]);
        const status = projectHostStatusForMobile({
            sampledAt: this.now(),
            system: {
                ...(cpuPercent !== undefined && { cpuPercent }),
                ...(this.options.system ?? readSystem)(),
                memoryTotalMb: memory.totalMb,
                memoryUsedMb: memory.usedMb,
                ...(memory.swapUsedMb !== undefined && { swapUsedMb: memory.swapUsedMb }),
            },
            ...(processes && { processes }),
        });
        this.latest = { at: this.now(), status };
        return status;
    }

    status(): Promise<MobileHostStatus> {
        const { latest } = this;
        if (latest && this.now() - latest.at < SHARED_SAMPLE_MS)
            return Promise.resolve(latest.status);
        // eslint-disable-next-line unicorn/prefer-await -- concurrent callers must share the in-flight promise itself
        this.inFlight ??= this.load().finally(() => {
            this.inFlight = undefined;
        });
        return this.inFlight;
    }
}
