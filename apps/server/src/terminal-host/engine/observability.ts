import type { StructuredLogger } from '@caxri/system';

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
