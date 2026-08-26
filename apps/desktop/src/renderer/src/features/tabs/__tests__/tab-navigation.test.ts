import { describe, expect, it } from 'vitest';

import { nextTabId } from '../tab-navigation';

describe('nextTabId', () => {
    it('steps forward and wraps from the last tab to the first', () => {
        const ids = ['a', 'b', 'c'];
        expect(nextTabId(ids, 'a', 1)).toBe('b');
        expect(nextTabId(ids, 'b', 1)).toBe('c');
        expect(nextTabId(ids, 'c', 1)).toBe('a');
    });

    it('steps backward and wraps from the first tab to the last', () => {
        const ids = ['a', 'b', 'c'];
        expect(nextTabId(ids, 'a', -1)).toBe('c');
        expect(nextTabId(ids, 'c', -1)).toBe('b');
    });

    it('returns undefined for an empty pane', () => {
        expect(nextTabId([], undefined, 1)).toBeUndefined();
        expect(nextTabId([], 'a', -1)).toBeUndefined();
    });

    it('falls back to the first tab forward and the last tab backward when nothing is active', () => {
        const ids = ['a', 'b', 'c'];
        expect(nextTabId(ids, undefined, 1)).toBe('a');
        expect(nextTabId(ids, undefined, -1)).toBe('c');
    });

    it('falls back the same way when the active tab no longer exists in the pane', () => {
        expect(nextTabId(['a', 'b'], 'stale', 1)).toBe('a');
    });

    it('is a no-op cycle for a single-tab pane', () => {
        expect(nextTabId(['only'], 'only', 1)).toBe('only');
        expect(nextTabId(['only'], 'only', -1)).toBe('only');
    });
});
