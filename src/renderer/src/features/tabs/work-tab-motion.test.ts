import { describe, expect, it } from 'vitest';

import { finishWorkTabMotion, reconcileWorkTabMotion } from './work-tab-motion';

interface Item {
    motionKey: string;
    label: string;
}

const item = (motionKey: string): Item => ({ label: motionKey, motionKey });

describe('work tab motion', () => {
    it('keeps restored tabs stable when animation is disabled', () => {
        expect(reconcileWorkTabMotion([], [item('a'), item('b')], false)).toEqual([
            { item: item('a'), phase: 'stable' },
            { item: item('b'), phase: 'stable' },
        ]);
    });

    it('marks only a newly opened tab as entering and settles it', () => {
        const current = reconcileWorkTabMotion([], [item('a')], false);
        const opened = reconcileWorkTabMotion(current, [item('a'), item('b')], true);

        expect(opened.map(({ item: entry, phase }) => [entry.motionKey, phase])).toEqual([
            ['a', 'stable'],
            ['b', 'enter'],
        ]);
        expect(finishWorkTabMotion(opened, 'b')[1]?.phase).toBe('stable');
    });

    it('keeps a removed tab inert at its previous position until exit finishes', () => {
        const current = reconcileWorkTabMotion([], [item('a'), item('b'), item('c')], false);
        const closing = reconcileWorkTabMotion(current, [item('a'), item('c')], true);

        expect(closing.map(({ item: entry, phase }) => [entry.motionKey, phase])).toEqual([
            ['a', 'stable'],
            ['b', 'exit'],
            ['c', 'stable'],
        ]);
        expect(finishWorkTabMotion(closing, 'b').map(({ item: entry }) => entry.motionKey)).toEqual(
            ['a', 'c'],
        );
    });

    it('preserves the original visual order while several tabs exit together', () => {
        const current = reconcileWorkTabMotion(
            [],
            [item('a'), item('b'), item('c'), item('d')],
            false,
        );

        const closingAll = reconcileWorkTabMotion(current, [], true);
        expect(closingAll.map(({ item: entry }) => entry.motionKey)).toEqual(['a', 'b', 'c', 'd']);
        expect(closingAll.every(({ phase }) => phase === 'exit')).toBe(true);

        const closingMiddle = reconcileWorkTabMotion(current, [item('a'), item('d')], true);
        expect(closingMiddle.map(({ item: entry }) => entry.motionKey)).toEqual([
            'a',
            'b',
            'c',
            'd',
        ]);
    });

    it('cancels a visual exit when the authoritative tab remains and removes motion for reduced preferences', () => {
        const current = reconcileWorkTabMotion([], [item('a')], false);
        const closing = reconcileWorkTabMotion(current, [], true);

        expect(reconcileWorkTabMotion(closing, [item('a')], true)[0]?.phase).toBe('stable');
        expect(reconcileWorkTabMotion(closing, [], false)).toEqual([]);
    });
});
