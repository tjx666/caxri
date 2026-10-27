import type { LogQueryRecord, LogQueryResult } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { appendLogPage, clearLogStream, emptyLogStream } from './log-stream';

const record = (() => {
    let sequence = 0;
    return (event: string): LogQueryRecord => {
        sequence += 1;
        return {
            id: String(sequence).padStart(24, '0'),
            timestamp: `2026-08-19T02:31:${String(sequence).padStart(2, '0')}.000Z`,
            process: 'server-core',
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

    it('deduplicates repeated ids within one server page', () => {
        const shared = record('shared');
        const state = appendLogPage(emptyLogStream, page([shared, shared]));

        expect(state.records).toEqual([shared]);
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

describe('gap dismiss epoch', () => {
    it('bumps the epoch when a fresh page (new cursor) reports a gap', () => {
        const first = appendLogPage(
            emptyLogStream,
            page([record('a')], { nextCursor: 'c1', gap: true }),
        );
        expect(first.gapEpoch).toBe(1);
    });

    it('does not bump the epoch again for a repeated poll of the same cursor', () => {
        const first = appendLogPage(
            emptyLogStream,
            page([record('a')], { nextCursor: 'c1', gap: true }),
        );
        // Same cursor, still reporting gap: true (server keeps flagging the same already-seen page).
        const repeated = appendLogPage(first, page([], { nextCursor: 'c1', gap: true }));
        expect(repeated.gapEpoch).toBe(1);
    });

    it('bumps the epoch again for a second, independent gap on a later cursor', () => {
        const first = appendLogPage(
            emptyLogStream,
            page([record('a')], { nextCursor: 'c1', gap: true }),
        );
        const clean = appendLogPage(first, page([record('b')], { nextCursor: 'c2' }));
        expect(clean.gapEpoch).toBe(1);
        const secondGap = appendLogPage(
            clean,
            page([record('c')], { nextCursor: 'c3', gap: true }),
        );
        expect(secondGap.gapEpoch).toBe(2);
        expect(secondGap.gap).toBe(true);
    });

    it('bumps (not resets) the epoch on clear, so a stale dismissal cannot hide a later gap', () => {
        const withGap = appendLogPage(
            emptyLogStream,
            page([record('a')], { nextCursor: 'c1', gap: true }),
        );
        const cleared = clearLogStream(withGap);
        expect(cleared.gapEpoch).toBe(2);
        const newGap = appendLogPage(cleared, page([record('b')], { nextCursor: 'c2', gap: true }));
        expect(newGap.gapEpoch).toBe(3);
    });
});
