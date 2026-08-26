import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { recordPtyDroppedBytes, recordPtyThroughput } from '../observability';

describe('PTY observability', () => {
    it('records bounded byte aggregates without Terminal content or identity', () => {
        const recordMetric = vi.fn<StructuredLogger['recordMetric']>();
        const logger = { recordMetric } as unknown as StructuredLogger;

        recordPtyThroughput(logger, { droppedBytes: 7, inputBytes: 3, outputBytes: 5 });
        recordPtyDroppedBytes(logger, 0);

        expect(recordMetric).toHaveBeenNthCalledWith(1, 'pty.throughput', 8, {
            owner: 'terminal-host',
            phase: 'transfer',
            outcome: 'success',
        });
        expect(recordMetric).toHaveBeenNthCalledWith(2, 'pty.dropped_bytes', 7, {
            owner: 'terminal-host',
            phase: 'transfer',
            outcome: 'overflow',
        });
        expect(recordMetric).toHaveBeenCalledTimes(2);
    });
});
