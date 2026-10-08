import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { GridBurstAccumulator } from '@caxri/utils';

const RESIZE_BURST_QUIET_MS = 250;
const RESIZE_BURST_MAX_DURATION_MS = 5_000;
const RESIZE_BURST_MAX_SAMPLES = 10_000;

interface PtyGridSize {
    cols: number;
    rows: number;
}

interface PtyResizeBurstState {
    accumulator: GridBurstAccumulator;
    lastSampleAt: number;
    maxDurationTimer?: NodeJS.Timeout;
    quietTimer?: NodeJS.Timeout;
    /**
     * Whether this burst was seeded from a grid applied before it began.
     */
    seeded: boolean;
    startedAt: number;
}

type PtyResizeBurstFlushReason = 'disposed' | 'max-duration' | 'quiet';

function isValidPtyGrid(size: PtyGridSize): boolean {
    return (
        Number.isSafeInteger(size.cols) &&
        size.cols >= 2 &&
        size.cols <= 1_000 &&
        Number.isSafeInteger(size.rows) &&
        size.rows >= 1 &&
        size.rows <= 1_000
    );
}

/**
 * Coalesces successful node-pty resizes by Terminal without retaining output, snapshots, commands, or paths.
 */
export class PtyResizeBurstObserver {
    private readonly bursts = new Map<string, PtyResizeBurstState>();
    private disposed = false;
    /**
     * Last applied grid per Terminal, remembered across bursts so the next burst can seed its `start` from the grid
     * actually in force instead of only its own first sample. Cleared when a Terminal is retired.
     */
    private readonly lastGrids = new Map<string, PtyGridSize>();

    constructor(private readonly logger: StructuredLogger) {}

    private flush(
        terminalId: string,
        state: PtyResizeBurstState,
        flushReason: PtyResizeBurstFlushReason,
    ): void {
        if (this.bursts.get(terminalId) !== state) return;
        if (state.quietTimer) clearTimeout(state.quietTimer);
        if (state.maxDurationTimer) clearTimeout(state.maxDurationTimer);
        this.bursts.delete(terminalId);
        const aggregate = state.accumulator.reset();
        if (!aggregate) return;
        const sampleCount = Math.min(aggregate.sampleCount, RESIZE_BURST_MAX_SAMPLES);
        // A seeded burst compares every real sample against the pre-burst grid too, so up to `sampleCount`
        // transitions are possible; an unseeded burst's first sample has nothing to compare against, so the bound
        // stays `sampleCount - 1`.
        const maxChangeCount = state.seeded ? sampleCount : Math.max(0, sampleCount - 1);
        try {
            this.logger.write('info', logEventCatalog.pty.resizeBurst, {
                fields: {
                    code: 'PTY_RESIZE_BURST',
                    terminalId,
                    side: 'terminal-host-pty',
                    sampleCount,
                    // Grid transitions relative to the grid in force before the burst; 0 means the burst
                    // re-sampled the existing grid and never changed it.
                    changeCount: Math.min(aggregate.changeCount, maxChangeCount),
                    startCols: aggregate.start.cols,
                    startRows: aggregate.start.rows,
                    minCols: aggregate.minimum.cols,
                    minRows: aggregate.minimum.rows,
                    maxCols: aggregate.maximum.cols,
                    maxRows: aggregate.maximum.rows,
                    finalCols: aggregate.final.cols,
                    finalRows: aggregate.final.rows,
                    durationMs: Math.min(
                        Math.max(0, state.lastSampleAt - state.startedAt),
                        RESIZE_BURST_MAX_DURATION_MS,
                    ),
                    flushReason,
                    truncated: aggregate.sampleCount > RESIZE_BURST_MAX_SAMPLES,
                },
            });
        } catch {
            // Best-effort diagnostics must never disturb the PTY resize or retirement path.
        }
    }

    recordApplied(terminalId: string, size: PtyGridSize): void {
        if (this.disposed || !isValidPtyGrid(size)) return;
        const sampledAt = Date.now();
        let state = this.bursts.get(terminalId);
        if (!state) {
            const previousGrid = this.lastGrids.get(terminalId);
            const created: PtyResizeBurstState = {
                accumulator: new GridBurstAccumulator(),
                startedAt: sampledAt,
                lastSampleAt: sampledAt,
                seeded: previousGrid !== undefined,
            };
            if (previousGrid) created.accumulator.seed(previousGrid);
            created.maxDurationTimer = setTimeout(
                () => this.flush(terminalId, created, 'max-duration'),
                RESIZE_BURST_MAX_DURATION_MS,
            );
            this.bursts.set(terminalId, created);
            state = created;
        }
        state.lastSampleAt = sampledAt;
        state.accumulator.sample(size);
        this.lastGrids.set(terminalId, { cols: size.cols, rows: size.rows });
        if (state.quietTimer) clearTimeout(state.quietTimer);
        const current = state;
        state.quietTimer = setTimeout(
            () => this.flush(terminalId, current, 'quiet'),
            RESIZE_BURST_QUIET_MS,
        );
    }

    disposeTerminal(terminalId: string): void {
        const state = this.bursts.get(terminalId);
        if (state) this.flush(terminalId, state, 'disposed');
        this.lastGrids.delete(terminalId);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const [terminalId, state] of this.bursts) this.flush(terminalId, state, 'disposed');
        this.lastGrids.clear();
    }
}

export interface PtyThroughputObservation {
    droppedBytes: number;
    inputBytes: number;
    outputBytes: number;
}

/**
 * Per-lifetime throughput totals for one live PTY. Every one-second aggregation window that carried bytes adds to these
 * counters, so the lifetime summary written at retirement can restore the session's total volume, its busiest window,
 * and how many windows were active without the log keeping one record per window.
 */
export interface PtyThroughputTally {
    droppedBytes: number;
    /**
     * Windows that dropped bytes over the whole lifetime, written in the retirement summary.
     */
    droppedWindows: number;
    /**
     * When the last `warn` `pty.throughput` drop record was written; undefined until the first drop.
     */
    dropLoggedAt?: number;
    /**
     * Dropped bytes and windows accumulated since that record, folded into the next one.
     */
    pendingDroppedBytes: number;
    pendingDroppedWindows: number;
    /**
     * Wall-clock time of the first input write, stamped by the engine when the bytes are actually written rather than
     * when their aggregation window closes, so `pty.first_input.durationMs` is a measured delay like every other
     * startup locator instead of one quantized to the one-second window boundary.
     */
    firstInputAt?: number;
    /**
     * Whether the one-shot `pty.first_input` record has already been written for this lifetime.
     */
    firstInputLogged: boolean;
    inputBytes: number;
    outputBytes: number;
    /**
     * Largest `inputBytes + outputBytes` observed in a single aggregation window.
     */
    peakWindowBytes: number;
    startedAt: number;
    /**
     * Number of aggregation windows that carried at least one byte.
     */
    windows: number;
}

export type PtyRetireReason = 'discarded' | 'exited' | 'restart' | 'shutdown';

export function createPtyThroughputTally(startedAt: number): PtyThroughputTally {
    return {
        droppedBytes: 0,
        droppedWindows: 0,
        firstInputLogged: false,
        pendingDroppedBytes: 0,
        pendingDroppedWindows: 0,
        inputBytes: 0,
        outputBytes: 0,
        peakWindowBytes: 0,
        startedAt,
        windows: 0,
    };
}

/**
 * Records one closed aggregation window for a live PTY.
 *
 * Steady-state throughput is owned by the metrics layer: `pty.throughput` enters the bounded metric registry on every
 * window without writing a matching per-window log record. Only two conditions still write durable records from a
 * window: dropped bytes remain a `warn` `pty.throughput` record (the anomaly signal `terminal-recovery.e2e.ts` waits
 * for), and the first window that carried input writes one `pty.first_input` record so the startup benchmark keeps a
 * low-frequency liveness signal.
 *
 * The first drop in a lifetime is written at once; later drops fold into at most one record per
 * {@link PTY_DROP_LOG_INTERVAL_MS}, carrying the bytes and windows dropped since the previous one. Production evidence
 * (#1182): one record per dropping window made `pty.throughput` 94% of `terminal-host.jsonl`: ~98,700 records for
 * ~348KB actually dropped. Nothing is lost: the retirement summary still totals every dropped byte and window.
 *
 * History: 24c4eb18 first silenced the per-second `info` record and 614cccee reverted it because
 * `e2e/startup.performance.e2e.ts` waited on `pty.throughput` with `inputBytes > 0`. That consumer and the Terminal
 * integration test now wait on `pty.first_input`, so the per-window record can be omitted without timing out the
 * release benchmark. See #590 and #605.
 */
const PTY_DROP_LOG_INTERVAL_MS = 60_000;

export function recordPtyThroughputWindow(
    logger: StructuredLogger,
    terminalId: string,
    tally: PtyThroughputTally,
    observation: PtyThroughputObservation,
    now = Date.now(),
): void {
    recordPtyThroughput(logger, observation);
    tally.windows += 1;
    tally.inputBytes += observation.inputBytes;
    tally.outputBytes += observation.outputBytes;
    tally.droppedBytes += observation.droppedBytes;
    tally.peakWindowBytes = Math.max(
        tally.peakWindowBytes,
        observation.inputBytes + observation.outputBytes,
    );
    if (observation.droppedBytes > 0) {
        tally.droppedWindows += 1;
        tally.pendingDroppedBytes += observation.droppedBytes;
        tally.pendingDroppedWindows += 1;
        if (
            tally.dropLoggedAt === undefined ||
            now - tally.dropLoggedAt >= PTY_DROP_LOG_INTERVAL_MS
        ) {
            logger.write('warn', logEventCatalog.pty.throughput, {
                fields: {
                    terminalId,
                    inputBytes: observation.inputBytes,
                    outputBytes: observation.outputBytes,
                    droppedBytes: tally.pendingDroppedBytes,
                    droppedWindows: tally.pendingDroppedWindows,
                },
            });
            tally.dropLoggedAt = now;
            tally.pendingDroppedBytes = 0;
            tally.pendingDroppedWindows = 0;
        }
    }
    if (tally.firstInputLogged || observation.inputBytes === 0) return;
    tally.firstInputLogged = true;
    logger.write('info', logEventCatalog.pty.firstInput, {
        durationMs: (tally.firstInputAt ?? now) - tally.startedAt,
        fields: { terminalId, inputBytes: observation.inputBytes },
    });
}

/**
 * Writes the single per-lifetime `pty.throughput_summary` record when a PTY retires. Totals, the peak window, and the
 * active-window count let an operator restore a session's volume from one record; `reason` explains which lifecycle
 * path ended it. Quiet lifetimes still write the record so an unexpectedly silent PTY is visible.
 */
export function recordPtyThroughputSummary(
    logger: StructuredLogger,
    terminalId: string,
    tally: PtyThroughputTally,
    reason: PtyRetireReason,
    now = Date.now(),
): void {
    logger.write('info', logEventCatalog.pty.throughputSummary, {
        durationMs: now - tally.startedAt,
        fields: {
            terminalId,
            reason,
            inputBytes: tally.inputBytes,
            outputBytes: tally.outputBytes,
            droppedBytes: tally.droppedBytes,
            droppedWindows: tally.droppedWindows,
            peakWindowBytes: tally.peakWindowBytes,
            windows: tally.windows,
        },
    });
}

/**
 * Aggregates PTY transfer pressure without retaining Terminal IDs, input, output, or per-chunk samples.
 */
export function recordPtyThroughput(
    logger: StructuredLogger,
    observation: PtyThroughputObservation,
): void {
    logger.recordMetric('pty.throughput', observation.inputBytes + observation.outputBytes, {
        owner: 'terminal-host',
        phase: 'transfer',
        outcome: 'success',
    });
    recordPtyDroppedBytes(logger, observation.droppedBytes);
}

export function recordPtyDroppedBytes(logger: StructuredLogger, droppedBytes: number): void {
    if (droppedBytes === 0) return;
    logger.recordMetric('pty.dropped_bytes', droppedBytes, {
        owner: 'terminal-host',
        phase: 'transfer',
        outcome: 'overflow',
    });
}
