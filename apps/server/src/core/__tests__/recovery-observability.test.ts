import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { logDurableReceipt, logDurableRecovery } from '../recovery-observability';

function createLogger() {
    const write = vi.fn<StructuredLogger['write']>();
    return { logger: { write } as unknown as StructuredLogger, write };
}

describe('recovery observability', () => {
    it('records receipt outcomes without command parameters or replies', () => {
        const { logger, write } = createLogger();

        logDurableReceipt(logger, {
            durationMs: 1.25,
            method: 'session.rename',
            outcome: 'stored',
            phase: 'store',
        });

        expect(write).toHaveBeenCalledWith('debug', 'server_core.command_receipt', {
            durationMs: 1.25,
            fields: {
                method: 'session.rename',
                outcome: 'stored',
                phase: 'store',
            },
        });
    });

    it('records recovery decisions without event or snapshot payloads', () => {
        const { logger, write } = createLogger();

        logDurableRecovery(logger, {
            cursor: 42,
            durationMs: 2.5,
            eventCount: 3,
            outcome: 'snapshot',
            reason: 'cursor-expired',
        });

        expect(write).toHaveBeenCalledWith('info', 'server_core.event_recovery', {
            durationMs: 2.5,
            fields: {
                cursor: 42,
                eventCount: 3,
                outcome: 'snapshot',
                reason: 'cursor-expired',
            },
        });
    });
});
