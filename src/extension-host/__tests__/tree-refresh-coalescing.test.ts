import { describe, expect, it } from 'vitest';

import { mergeTreeRefresh } from '../tree-refresh-coalescing';

describe('mergeTreeRefresh', () => {
    it('unions targeted handles without losing earlier branches', () => {
        const first = mergeTreeRefresh(undefined, ['a']);
        const second = mergeTreeRefresh(first, ['b', 'a']);

        expect(second?.root).toBe(false);
        expect([...second!.handles]).toEqual(['a', 'b']);
    });

    it('gives a root refresh precedence over targeted events', () => {
        const targeted = mergeTreeRefresh(undefined, ['a']);
        const root = mergeTreeRefresh(targeted, undefined);
        const afterRoot = mergeTreeRefresh(root, ['b']);

        expect(afterRoot).toEqual({ root: true, handles: new Set() });
    });

    it('treats an empty handle list as a no-op', () => {
        expect(mergeTreeRefresh(undefined, [])).toBeUndefined();
        const targeted = mergeTreeRefresh(undefined, ['a']);
        expect(mergeTreeRefresh(targeted, [])).toBe(targeted);
    });
});
