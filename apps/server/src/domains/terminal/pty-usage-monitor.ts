import process from 'node:process';

import type { PtyUsage, ServerEvent, TerminalPtyAlert } from '@caxri/protocol';
import { errorMessage, isPtyUsageHigh, PTY_USAGE_ALERT_RATIO } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, samplePtyUsage, samplePtyUsageUpperBound } from '@caxri/system';

import type { WatchHandle, WatchHub } from '../watch';
import type { E2EPtyUsageOverride } from './e2e-pty-usage-override';
import { resolveE2EPtyUsageOverride } from './e2e-pty-usage-override';

/**
 * PTY slots fill up over minutes of opening Terminals and Agent commands, not seconds, so a half-minute check warns
 * long before the last slot goes while keeping the background cost negligible.
 */
const PTY_USAGE_SAMPLE_INTERVAL_MS = 30_000;
/**
 * How long one full reading answers repeated reads; Process Explorer asks every two seconds while it is open.
 */
const PTY_USAGE_CACHE_MS = 1_500;
/**
 * The alert clears only once use falls this far below the limit, so a machine hovering at the alert share does not
 * raise and retract the notice on every sample.
 */
const PTY_USAGE_CLEAR_RATIO = PTY_USAGE_ALERT_RATIO - 0.05;
const MAX_LOGGED_HOLDERS = 5;

interface PtyUsageMonitorOptions {
    intervalMs?: number;
    logger: StructuredLogger;
    now?: () => number;
    /**
     * E2E-only injected reading; see `e2e-pty-usage-override.ts`. Defaults to the seam resolved from the process
     * environment, which is absent outside an explicit E2E launch.
     */
    readingOverride?: E2EPtyUsageOverride;
    sampleUpperBound?: () => Promise<{ limit: number; upperBound: number } | undefined>;
    sampleUsage?: () => Promise<PtyUsage | undefined>;
    send: (event: ServerEvent) => void;
    watchHub: Pick<WatchHub, 'registerPoller'>;
}

interface AlertEpisode {
    lastInUse: number;
    limit: number;
    peakInUse: number;
    raisedAt: number;
}

/**
 * Reads the machine's PTY slots for Process Explorer and warns once their use nears the kernel limit, past which no
 * application on the machine can open a terminal.
 *
 * The background check first counts PTY device nodes, which never undercounts use, and runs the costlier full holder
 * scan only when that count already reaches the alert share; an ordinary machine therefore never pays for `lsof` here.
 */
export class PtyUsageMonitor {
    private cached?: { at: number; usage: PtyUsage | undefined };
    private episode?: AlertEpisode;
    private inFlight?: Promise<PtyUsage | undefined>;
    private poller?: WatchHandle;
    private readonly readingOverride: E2EPtyUsageOverride | undefined;

    constructor(private readonly options: PtyUsageMonitorOptions) {
        this.readingOverride = options.readingOverride ?? resolveE2EPtyUsageOverride(process.env);
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    /**
     * A failed scan (`lsof` timing out on a loaded machine, a process vanishing mid-read) is logged and reads as "no
     * reading" rather than failing `terminal.ptyUsage`: Process Explorer then simply omits the PTY figures.
     */
    private async sampleMachine(): Promise<PtyUsage | undefined> {
        try {
            return await (this.options.sampleUsage ?? samplePtyUsage)();
        } catch (error) {
            this.options.logger.write('warn', logEventCatalog.terminal.ptySampleFailed, {
                fields: { error: errorMessage(error, 'unknown') },
            });
            return undefined;
        }
    }

    private async load(): Promise<PtyUsage | undefined> {
        const [usage, override] = await Promise.all([
            this.sampleMachine(),
            this.readingOverride?.read(),
        ]);
        if (!override) return usage;
        return { holders: usage?.holders ?? [], ...override };
    }

    private async loadAndCache(): Promise<PtyUsage | undefined> {
        try {
            const usage = await this.load();
            this.cached = { at: this.now(), usage };
            return usage;
        } finally {
            this.inFlight = undefined;
        }
    }

    private raise(usage: PtyUsage): void {
        this.episode = {
            lastInUse: usage.inUse,
            limit: usage.limit,
            peakInUse: usage.inUse,
            raisedAt: this.now(),
        };
        const topHolders = usage.holders
            .toSorted((left, right) => right.count - left.count)
            .slice(0, MAX_LOGGED_HOLDERS);
        this.options.logger.write('warn', logEventCatalog.terminal.ptyAlertRaised, {
            fields: {
                inUse: usage.inUse,
                limit: usage.limit,
                holders: topHolders.map(({ count, pid }) => `${pid}:${count}`).join(','),
            },
        });
        this.publish({ state: 'raised', inUse: usage.inUse, limit: usage.limit });
    }

    private clear(usage: Pick<PtyUsage, 'inUse' | 'limit'>, reason: 'recovered' | 'stopped'): void {
        const { episode } = this;
        if (!episode) return;
        this.episode = undefined;
        this.options.logger.write('info', logEventCatalog.terminal.ptyAlertCleared, {
            durationMs: this.now() - episode.raisedAt,
            fields: { limit: usage.limit, peakInUse: episode.peakInUse, reason },
        });
        this.publish({ state: 'cleared', inUse: usage.inUse, limit: usage.limit });
    }

    private publish(alert: TerminalPtyAlert): void {
        this.options.send({ event: 'terminal.ptyAlert', payload: alert });
    }

    /**
     * The current reading, shared by concurrent callers and reused for a moment so Process Explorer's two-second
     * refresh and the background check never scan twice for one answer. `undefined` where the platform has no readable
     * limit.
     */
    async usage(): Promise<PtyUsage | undefined> {
        if (this.cached && this.now() - this.cached.at < PTY_USAGE_CACHE_MS)
            return this.cached.usage;
        this.inFlight ??= this.loadAndCache();
        return this.inFlight;
    }

    start(): void {
        this.poller = this.options.watchHub.registerPoller({
            intervalMs:
                this.options.intervalMs ??
                this.readingOverride?.intervalMs ??
                PTY_USAGE_SAMPLE_INTERVAL_MS,
            label: 'pty-usage-monitor',
            pollOnce: () => this.sample(),
        });
    }

    async sample(): Promise<void> {
        let usage: PtyUsage | undefined;
        try {
            if (!this.episode && !this.readingOverride) {
                const bound = await (this.options.sampleUpperBound ?? samplePtyUsageUpperBound)();
                if (!bound || !isPtyUsageHigh({ inUse: bound.upperBound, limit: bound.limit }))
                    return;
            }
            usage = await this.usage();
        } catch (error) {
            this.options.logger.write('warn', logEventCatalog.terminal.ptySampleFailed, {
                fields: { error: errorMessage(error, 'unknown') },
            });
            return;
        }
        if (!usage) return;
        if (this.episode) {
            this.episode.peakInUse = Math.max(this.episode.peakInUse, usage.inUse);
            this.episode.lastInUse = usage.inUse;
            this.episode.limit = usage.limit;
            if (usage.inUse < Math.ceil(usage.limit * PTY_USAGE_CLEAR_RATIO))
                this.clear(usage, 'recovered');
            return;
        }
        if (isPtyUsageHigh(usage)) this.raise(usage);
    }

    async close(): Promise<void> {
        await this.poller?.dispose();
        this.poller = undefined;
        const { episode } = this;
        if (episode) this.clear({ inUse: episode.lastInUse, limit: episode.limit }, 'stopped');
    }
}
