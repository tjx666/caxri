import type { LogQueryRecord } from '@shared/types';
import { describe, expect, it } from 'vitest';

import { isLogFilterMatch, logRecordHaystack, parseLogFilter } from './log-filter';

const record: LogQueryRecord = {
    id: 'a'.repeat(24),
    timestamp: '2026-08-19T02:31:40.000Z',
    process: 'runtime',
    level: 'warn',
    event: 'ipc.request',
    correlationId: 'request-7',
    durationMs: 42,
    fields: { method: 'terminal.attach', queueMs: 1200 },
};

describe('VS Code-style log text filter', () => {
    it('treats comma-separated patterns as OR and matches case-insensitively', () => {
        const filter = parseLogFilter('MISSING, IPC.REQ');
        expect(isLogFilterMatch(logRecordHaystack(record), filter)).toBe(true);
        expect(isLogFilterMatch(logRecordHaystack(record), parseLogFilter('missing'))).toBe(false);
    });

    it('hides records matching a ! exclusion even when an include also matches', () => {
        const filter = parseLogFilter('ipc, !terminal.attach');
        expect(isLogFilterMatch(logRecordHaystack(record), filter)).toBe(false);
    });

    it('keeps quoted commas and a quoted leading ! literal', () => {
        expect(parseLogFilter('"a,b", !"c,d"')).toEqual({
            includes: ['a,b'],
            excludes: ['c,d'],
        });
        expect(parseLogFilter('"!literal"')).toEqual({ includes: ['!literal'], excludes: [] });
    });

    it('matches everything on an empty or exclusion-only filter with no exclusion hits', () => {
        expect(isLogFilterMatch(logRecordHaystack(record), parseLogFilter(''))).toBe(true);
        expect(isLogFilterMatch(logRecordHaystack(record), parseLogFilter('!missing'))).toBe(true);
    });

    it('searches structured fields and the correlation id', () => {
        expect(isLogFilterMatch(logRecordHaystack(record), parseLogFilter('queuems'))).toBe(true);
        expect(isLogFilterMatch(logRecordHaystack(record), parseLogFilter('request-7'))).toBe(true);
    });
});
