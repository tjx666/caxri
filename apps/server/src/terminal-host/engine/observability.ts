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
        try {
            this.logger.write('info', logEventCatalog.pty.resizeBurst, {
                fields: {
                    code: 'PTY_RESIZE_BURST',
                    terminalId,
                    side: 'terminal-host-pty',
                    sampleCount,
                    changeCount: Math.min(aggregate.changeCount, sampleCount - 1),
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
            const created: PtyResizeBurstState = {
                accumulator: new GridBurstAccumulator(),
                startedAt: sampledAt,
                lastSampleAt: sampledAt,
            };
            created.maxDurationTimer = setTimeout(
                () => this.flush(terminalId, created, 'max-duration'),
                RESIZE_BURST_MAX_DURATION_MS,
            );
            this.bursts.set(terminalId, created);
            state = created;
        }
        state.lastSampleAt = sampledAt;
        state.accumulator.sample(size);
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
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const [terminalId, state] of this.bursts) this.flush(terminalId, state, 'disposed');
    }
}

export interface PtyThroughputObservation {
    droppedBytes: number;
    inputBytes: number;
    outputBytes: number;
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
