import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { SessionContextTelemetry } from '../session-context-telemetry';

interface LoggedWrite {
    durationMs?: number;
    fields: Record<string, unknown>;
    level: string;
}

function createTelemetry(windowMs = 60_000) {
    let now = 1_000;
    const write = vi.fn<StructuredLogger['write']>();
    const telemetry = new SessionContextTelemetry(
        { write } as unknown as StructuredLogger,
        windowMs,
        () => now,
    );
    return {
        advance: (ms: number) => (now += ms),
        telemetry,
        write,
        writesOf: (event: string, level?: string): LoggedWrite[] =>
            write.mock.calls
                .filter(
                    ([recordLevel, recordEvent]) =>
                        recordEvent === event && (level === undefined || recordLevel === level),
                )
                .map(([recordLevel, , options]) => ({
                    durationMs: options?.durationMs,
                    fields: options?.fields ?? {},
                    level: recordLevel,
                })),
    };
}

describe('SessionContextTelemetry', () => {
    it('counts a routine missing transcript only in the aggregate and logs a real rejection at warn', () => {
        const { telemetry, writesOf } = createTelemetry();
        telemetry.recordFailure('session-a', 'missing');
        telemetry.recordFailure('session-a', 'symlinkRejected');
        telemetry.recordFailure('session-a', 'hardlinkRejected');
        telemetry.recordFailure('session-a', 'identityMismatch');

        expect(
            writesOf('session_context.scan_failed').map(({ fields, level }) => [
                level,
                fields.reason,
            ]),
        ).toEqual([
            ['warn', 'symlinkRejected'],
            ['warn', 'hardlinkRejected'],
            ['warn', 'identityMismatch'],
        ]);
    });

    it('logs a cursor reset immediately as a state transition, not just inside the window aggregate', () => {
        const { telemetry, writesOf } = createTelemetry();
        telemetry.recordReset('session-a');
        expect(writesOf('session_context.cursor_reset', 'info')).toEqual([
            { durationMs: undefined, fields: { sessionId: 'session-a' }, level: 'info' },
        ]);
    });

    it('publishes one aggregate per elapsed window with scan count, duration, bytes, and failure breakdown', () => {
        const { advance, telemetry, writesOf } = createTelemetry(60_000);
        telemetry.recordScan('session-a', 10, 512);
        telemetry.recordFailure('session-a', 'missing');
        advance(20_000);
        telemetry.recordScan('session-a', 35, 2_048);
        telemetry.recordReset('session-a');
        expect(writesOf('session_context.scan_window')).toHaveLength(0);

        advance(40_000);
        telemetry.recordScan('session-a', 5, 128);
        const [aggregate] = writesOf('session_context.scan_window');
        // Spans the first to the last counted scan, not to the moment the window closed.
        expect(aggregate).toMatchObject({
            level: 'info',
            durationMs: 20_000,
            fields: {
                sessionId: 'session-a',
                scans: 2,
                resets: 1,
                totalDurationMs: 45,
                maxDurationMs: 35,
                bytesScanned: 2_560,
                failureMissing: 1,
            },
        });
    });

    it('keeps windows independent per Session', () => {
        const { telemetry, writesOf } = createTelemetry();
        telemetry.recordScan('session-a', 10, 100);
        telemetry.recordScan('session-b', 20, 200);
        telemetry.flush();
        expect(
            writesOf('session_context.scan_window').map((record) => record.fields.sessionId),
        ).toEqual(['session-a', 'session-b']);
    });

    it('flushes open windows on eviction without double-publishing on a later flush', () => {
        const { telemetry, writesOf } = createTelemetry();
        telemetry.recordScan('session-a', 10, 100);
        telemetry.flush(['session-a']);
        expect(writesOf('session_context.scan_window')).toHaveLength(1);
        telemetry.flush(['session-a']);
        expect(writesOf('session_context.scan_window')).toHaveLength(1);
    });

    it('reports a burst followed by idling as the burst, not as the idle time', () => {
        const { advance, telemetry, writesOf } = createTelemetry(60_000);
        telemetry.recordScan('session-a', 10, 100);
        advance(5_000);
        telemetry.recordScan('session-a', 10, 100);
        advance(7_200_000);
        telemetry.flush();
        expect(writesOf('session_context.scan_window')[0]).toMatchObject({
            durationMs: 5_000,
            fields: { scans: 2 },
        });
    });
});
