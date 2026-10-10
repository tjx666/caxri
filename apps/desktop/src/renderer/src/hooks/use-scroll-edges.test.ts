import { describe, expect, it } from 'vitest';

import type { ScrollEdges } from './use-scroll-edges';
import { applyScrollEdgeIntersections } from './use-scroll-edges';

const NEITHER: ScrollEdges = { canScrollStart: false, canScrollEnd: false };

describe('applyScrollEdgeIntersections', () => {
    it('leaves both edges off while both sentinels stay visible', () => {
        expect(
            applyScrollEdgeIntersections(NEITHER, [
                { edge: 'start', isIntersecting: true },
                { edge: 'end', isIntersecting: true },
            ]),
        ).toEqual(NEITHER);
    });

    it('turns on the end fade once the end sentinel scrolls out of view', () => {
        expect(
            applyScrollEdgeIntersections(NEITHER, [{ edge: 'end', isIntersecting: false }]),
        ).toEqual({ canScrollStart: false, canScrollEnd: true });
    });

    it('turns on the start fade once the start sentinel scrolls out of view', () => {
        expect(
            applyScrollEdgeIntersections(NEITHER, [{ edge: 'start', isIntersecting: false }]),
        ).toEqual({ canScrollStart: true, canScrollEnd: false });
    });

    it('turns the end fade back off once the end sentinel scrolls back into view', () => {
        const scrolledAway: ScrollEdges = { canScrollStart: true, canScrollEnd: true };
        expect(
            applyScrollEdgeIntersections(scrolledAway, [{ edge: 'end', isIntersecting: true }]),
        ).toEqual({ canScrollStart: true, canScrollEnd: false });
    });

    it('returns the same object when an update changes nothing, so callers can skip a re-render', () => {
        const settled: ScrollEdges = { canScrollStart: false, canScrollEnd: true };
        expect(
            applyScrollEdgeIntersections(settled, [{ edge: 'end', isIntersecting: false }]),
        ).toBe(settled);
    });

    it('applies several intersection updates from one observer callback in order', () => {
        expect(
            applyScrollEdgeIntersections(NEITHER, [
                { edge: 'start', isIntersecting: false },
                { edge: 'end', isIntersecting: false },
            ]),
        ).toEqual({ canScrollStart: true, canScrollEnd: true });
    });
});
