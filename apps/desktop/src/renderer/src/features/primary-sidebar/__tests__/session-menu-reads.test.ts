import { describe, expect, it } from 'vitest';

import { botHandoverEntryKind, LastKnownReads, resolveMenuRead } from '../session-menu-reads';

describe('resolveMenuRead', () => {
    it('uses the fresh value when the read answered', () => {
        expect(resolveMenuRead({ timedOut: false, value: false }, true, false)).toBe(false);
    });

    it('falls back to the last-known value on timeout', () => {
        expect(resolveMenuRead({ timedOut: true }, true, false)).toBe(true);
    });

    it('uses the hiding fallback when nothing is known', () => {
        expect(resolveMenuRead({ timedOut: true }, undefined, false)).toBe(false);
        expect(resolveMenuRead<string[]>({ timedOut: true }, undefined, [])).toEqual([]);
    });
});

describe('botHandoverEntryKind', () => {
    it('follows a fresh answer', () => {
        expect(botHandoverEntryKind({ timedOut: false, value: true }, false)).toBe('takeBack');
        expect(botHandoverEntryKind({ timedOut: false, value: false }, true)).toBe('handOver');
    });

    it('keeps the last-known entry on timeout', () => {
        expect(botHandoverEntryKind({ timedOut: true }, true)).toBe('takeBack');
        expect(botHandoverEntryKind({ timedOut: true }, false)).toBe('handOver');
    });

    it('offers neither without a last-known value', () => {
        expect(botHandoverEntryKind({ timedOut: true }, undefined)).toBe('none');
    });
});

describe('LastKnownReads', () => {
    it('stores per Session and evicts the oldest past the limit', () => {
        const reads = new LastKnownReads<boolean>(2);
        reads.set('a', true);
        reads.set('b', false);
        reads.set('c', true);
        expect(reads.get('a')).toBeUndefined();
        expect(reads.get('b')).toBe(false);
        expect(reads.get('c')).toBe(true);
    });
});
