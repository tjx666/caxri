import type { LogQueryRecord, LogQueryResult } from '@shared/types';
import { describe, expect, it } from 'vitest';

import { appendLogPage, clearLogStream, emptyLogStream } from './log-stream';

const record = (() => {
    let sequence = 0;
    return (event: string): LogQueryRecord => {
        sequence += 1;
        return {
            id: String(sequence).padStart(24, '0'),
            timestamp: `2026-08-19T02:31:${String(sequence).padStart(2, '0')}.000Z`,
            process: 'runtime',
            level: 'info',
            event,
        };
    };
})();

function page(records: LogQueryRecord[], overrides: Partial<LogQueryResult> = {}): LogQueryResult {
    return { records, gap: false, truncated: false, ...overrides };
}

describe('cursor-follow log stream accumulation', () => {
    it('appends pages in order, adopts the newest cursor, and latches gap', () => {
        const first = appendLogPage(
            emptyLogStream,
            page([record('a'), record('b')], { nextCursor: 'cursor-1' }),
        );
        const second = appendLogPage(
            first,
            page([record('c')], { nextCursor: 'cursor-2', gap: true }),
        );
        expect(second.records.map(({ event }) => event)).toEqual(['a', 'b', 'c']);
        expect(second.cursor).toBe('cursor-2');
        expect(second.gap).toBe(true);
        const third = appendLogPage(second, page([], { nextCursor: 'cursor-2' }));
        expect(third.gap).toBe(true);
    });

    it('returns the identical state for an idle poll so effects skip re-renders', () => {
        const state = appendLogPage(emptyLogStream, page([record('a')], { nextCursor: 'c1' }));
        expect(appendLogPage(state, page([], { nextCursor: 'c1' }))).toBe(state);
    });

    it('deduplicates re-fetched records by id and caps the buffer from the front', () => {
        const shared = record('shared');
        const state = appendLogPage(emptyLogStream, page([shared]));
        const again = appendLogPage(state, page([shared, record('new')]), 2);
        expect(again.records.map(({ event }) => event)).toEqual(['shared', 'new']);
        const capped = appendLogPage(again, page([record('overflow')]), 2);
        expect(capped.records.map(({ event }) => event)).toEqual(['new', 'overflow']);
    });

    it('clears records but keeps the cursor so history does not replay', () => {
        const state = appendLogPage(
            emptyLogStream,
            page([record('a')], { nextCursor: 'c1', gap: true }),
        );
        const cleared = clearLogStream(state);
        expect(cleared.records).toEqual([]);
        expect(cleared.cursor).toBe('c1');
        expect(cleared.gap).toBe(false);
    });
});
