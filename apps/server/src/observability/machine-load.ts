import os from 'node:os';
import { performance } from 'node:perf_hooks';

import type { BackgroundWorkSource } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * One-minute load average per logical core that marks the machine as loaded, and the lower bound it must fall back
 * under before background work resumes. The gap keeps a load hovering at the threshold from flapping every sample. A
 * run queue at one thread per core is where an interactive request starts to wait for a CPU.
 */
const ENTER_LOAD_PER_CORE = 1;
const EXIT_LOAD_PER_CORE = 0.7;
/**
 * The kernel only recomputes the load average every few seconds, so sampling faster would read the same value.
 */
const SAMPLE_INTERVAL_MS = 5_000;
/**
 * The longest one background source keeps skipping rounds. A build or a busy Agent can hold a laptop above the
 * threshold for many minutes, and delivery status that never refreshes would be worse than one round of extra load.
 */
const MAX_DEFERRAL_MS = 120_000;

/**
 * What a background driver consults before it spends Git or CLI work. Injected so tests can hold the machine loaded.
 */
export interface BackgroundLoadGate {
    /**
     * Whether `source` should skip this round, recording the skip when it should. Lets one round through after the
     * source has been deferring for `MAX_DEFERRAL_MS`, so sustained load slows background refresh instead of stopping
     * it.
     */
    shouldDefer(source: BackgroundWorkSource): boolean;
}

interface MachineLoadOptions {
    now?: () => number;
    /**
     * Load per logical core; zero where the platform reports no load average (Windows).
     */
    sample?: () => number;
}

function sampleLoadPerCore(): number {
    return (os.loadavg()[0] ?? 0) / Math.max(1, os.availableParallelism());
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Tells background refresh when the whole machine, not just Server Core, is saturated: a home-wide file scan or a
 * native build elsewhere makes every Git child slow without ever stalling this process's event loop, so the stall
 * monitor cannot see it. Sampling is lazy, on the next query after the interval, so an idle Server spends nothing.
 */
export class MachineLoadMonitor implements BackgroundLoadGate {
    private logger?: StructuredLogger;
    private sampledAt = -Infinity;
    /**
     * When each source started its current run of skipped rounds.
     */
    private readonly deferringSince = new Map<BackgroundWorkSource, number>();
    private episode?: {
        deferred: Map<BackgroundWorkSource, number>;
        peakLoadPerCore: number;
        startedAt: number;
    };

    constructor(private readonly options: MachineLoadOptions = {}) {}

    private now(): number {
        return (this.options.now ?? performance.now.bind(performance))();
    }

    private observe(loadPerCore: number, now: number): void {
        const { episode } = this;
        if (!episode) {
            if (loadPerCore < ENTER_LOAD_PER_CORE) return;
            this.episode = { deferred: new Map(), peakLoadPerCore: loadPerCore, startedAt: now };
            this.logger?.write('info', logEventCatalog.serverCore.loadChanged, {
                fields: { state: 'loaded', loadPerCore: round(loadPerCore) },
            });
            return;
        }
        episode.peakLoadPerCore = Math.max(episode.peakLoadPerCore, loadPerCore);
        if (loadPerCore >= EXIT_LOAD_PER_CORE) return;
        this.episode = undefined;
        const deferred = [...episode.deferred]
            .toSorted(([, left], [, right]) => right - left)
            .map(([source, count]) => `${source}=${count}`)
            .join(',');
        this.logger?.write('info', logEventCatalog.serverCore.loadChanged, {
            durationMs: now - episode.startedAt,
            fields: {
                state: 'normal',
                loadPerCore: round(loadPerCore),
                peakLoadPerCore: round(episode.peakLoadPerCore),
                ...(deferred && { deferred }),
            },
        });
    }

    /**
     * Turns the monitor on and starts writing `server_core.load_changed` transitions. Until then it reports the machine
     * as idle, so a Server Core assembled in tests never defers work because the test runner is busy.
     */
    attach(logger: StructuredLogger): void {
        this.logger = logger;
    }

    isLoaded(): boolean {
        if (!this.logger) return false;
        const now = this.now();
        if (now - this.sampledAt >= SAMPLE_INTERVAL_MS) {
            this.sampledAt = now;
            this.observe((this.options.sample ?? sampleLoadPerCore)(), now);
        }
        return this.episode !== undefined;
    }

    shouldDefer(source: BackgroundWorkSource): boolean {
        const loaded = this.isLoaded();
        const { episode } = this;
        if (!loaded || !episode) {
            this.deferringSince.delete(source);
            return false;
        }
        const now = this.now();
        const since = this.deferringSince.get(source);
        if (since !== undefined && now - since >= MAX_DEFERRAL_MS) {
            this.deferringSince.delete(source);
            return false;
        }
        if (since === undefined) this.deferringSince.set(source, now);
        episode.deferred.set(source, (episode.deferred.get(source) ?? 0) + 1);
        return true;
    }
}

/**
 * The Server Core process's monitor; the process entry attaches its logger, which turns it on.
 */
export const machineLoad = new MachineLoadMonitor();
