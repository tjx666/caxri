import type { WorkbenchComposedReadDiagnostic } from '@caxri/protocol';

/**
 * A composed Workbench read at or above this duration is always reported. It is the point where the refresh stops
 * feeling instant: a read is this Mac's `app.bootstrap` plus any SSH Host's re-read, so a quarter second means a
 * `state.changed` burst from a Host is already holding the side bar behind a network round trip.
 */
export const COMPOSED_READ_SLOW_BUDGET_MS = 250;

/**
 * Every Nth Host-triggered read is reported even when fast, so the rate of Host `state.changed` amplification stays
 * visible in a log where every read is cheap. Fast local-only reads are never sampled; they are not the question.
 */
export const COMPOSED_READ_SAMPLE_EVERY = 50;

/**
 * What one composed read observed. Durations are milliseconds; `remoteReadMs` is the slowest Host read actually
 * performed (`0` when none ran).
 */
export interface ComposedReadSample {
    connectedHostCount: number;
    /**
     * Connected Hosts that were marked changed when the read began.
     */
    dirtyHostCount: number;
    localBootstrapMs: number;
    remoteReadCount: number;
    remoteReadMs: number;
    totalMs: number;
}

export interface ComposedReadMeterDependencies {
    createDiagnosticId?: () => string;
    reportDiagnostic: (diagnostic: WorkbenchComposedReadDiagnostic) => void;
}

/**
 * Counts this window's composed Workbench reads and reports the slow ones plus a periodic sample of Host-triggered
 * ones. The record carries only durations and counts: no Project, Session, path, or Host name.
 */
export class ComposedReadMeter {
    private composedReadCount = 0;
    private hostChangeReadCount = 0;
    private slowReadCount = 0;

    constructor(private readonly dependencies: ComposedReadMeterDependencies) {}

    record(sample: ComposedReadSample): void {
        const trigger = sample.dirtyHostCount > 0 ? 'host-change' : 'local';
        const isSlow = sample.totalMs >= COMPOSED_READ_SLOW_BUDGET_MS;
        this.composedReadCount += 1;
        if (trigger === 'host-change') this.hostChangeReadCount += 1;
        if (isSlow) this.slowReadCount += 1;

        const isSampled =
            trigger === 'host-change' &&
            sample.connectedHostCount > 0 &&
            this.hostChangeReadCount % COMPOSED_READ_SAMPLE_EVERY === 0;
        if (!isSlow && !isSampled) return;

        const createDiagnosticId =
            this.dependencies.createDiagnosticId ?? (() => crypto.randomUUID());
        this.dependencies.reportDiagnostic({
            kind: 'workbench-composed-read',
            diagnosticId: createDiagnosticId(),
            trigger,
            slow: isSlow,
            totalMs: Math.round(sample.totalMs),
            localBootstrapMs: Math.round(sample.localBootstrapMs),
            remoteReadMs: Math.round(sample.remoteReadMs),
            connectedHostCount: sample.connectedHostCount,
            remoteReadCount: sample.remoteReadCount,
            composedReadCount: this.composedReadCount,
            hostChangeReadCount: this.hostChangeReadCount,
            slowReadCount: this.slowReadCount,
        });
    }
}

/**
 * The window's meter, reporting through the secure Preload bridge.
 */
export const composedReadMeter = new ComposedReadMeter({
    reportDiagnostic: (diagnostic) => globalThis.caxri.reportDiagnostic(diagnostic),
});
