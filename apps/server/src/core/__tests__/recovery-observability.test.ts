import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import {
    logDurableReceipt,
    logDurableRecovery,
    prepareServerEventForDelivery,
} from '../recovery-observability';

function createLogger() {
    const write = vi.fn<StructuredLogger['write']>();
    const recordMetric = vi.fn<StructuredLogger['recordMetric']>();
    return { logger: { recordMetric, write } as unknown as StructuredLogger, recordMetric, write };
}

describe('recovery observability', () => {
    it('rejects invalid domain events with bounded content-free validation evidence', () => {
        const { logger, write } = createLogger();
        const event = {
            event: 'files.changed',
            payload: {
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-1',
                changes: Array.from({ length: 513 }, (_, index) => ({
                    path: `/private/source-${index}.txt`,
                    kind: 'update',
                })),
                overflow: false,
            },
        } satisfies ServerEvent;

        expect(prepareServerEventForDelivery(logger, event)).toEqual({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        expect(write).toHaveBeenCalledWith('error', 'server_core.event_rejected', {
            fields: {
                arraySizes: 'payload.changes=513',
                eventName: 'files.changed',
                issueCount: 1,
                issues: 'payload.changes:too_big',
            },
        });
        expect(JSON.stringify(write.mock.calls)).not.toContain('/private/source-');
    });

    it('keeps a rejected event non-fatal when the diagnostic sink fails', () => {
        const write = vi.fn(() => {
            throw new Error('log unavailable');
        });
        const logger = { write } as unknown as StructuredLogger;
        const event = {
            event: 'files.changed',
            payload: {
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-1',
                changes: Array.from({ length: 513 }, () => ({
                    path: '/private/source.txt',
                    kind: 'update' as const,
                })),
                overflow: false,
            },
        } satisfies ServerEvent;

        expect(prepareServerEventForDelivery(logger, event)).toEqual({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        expect(write).toHaveBeenCalledOnce();
    });

    it('accepts valid high-frequency terminal output without diagnostics', () => {
        const { logger, write } = createLogger();
        const event = {
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'opaque output' },
        } satisfies ServerEvent;

        expect(prepareServerEventForDelivery(logger, event)).toEqual(event);
        expect(write).not.toHaveBeenCalled();
    });

    it('rejects malformed terminal output before binary delivery', () => {
        const { logger, write } = createLogger();
        const event = {
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 42 },
        } as unknown as ServerEvent;

        expect(prepareServerEventForDelivery(logger, event)).toEqual({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        expect(write).toHaveBeenCalledWith('error', 'server_core.event_rejected', {
            fields: {
                eventName: 'terminal.output',
                issueCount: 1,
                issues: 'payload.data:invalid_type',
            },
        });
    });

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
        const { logger, recordMetric, write } = createLogger();

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
        expect(recordMetric).toHaveBeenNthCalledWith(1, 'changefeed.lag', 3, {
            owner: 'server-core',
            phase: 'recovery',
            outcome: 'success',
        });
        expect(recordMetric).toHaveBeenNthCalledWith(2, 'changefeed.snapshot', 1, {
            owner: 'server-core',
            phase: 'recovery',
            outcome: 'success',
        });
    });
});
