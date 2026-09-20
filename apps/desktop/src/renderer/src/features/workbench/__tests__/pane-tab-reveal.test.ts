import { describe, expect, it } from 'vitest';

import { planTabReveal } from '../pane-tab-reveal';

/**
 * A 400px rail scrolled to `scrollLeft`, holding one tab whose viewport span is given. Viewport coordinates, so the
 * rail always occupies 0..400 no matter how far it is scrolled.
 */
function geometry(options: { scrollLeft: number; tabEnd: number; tabStart: number }) {
    return { railEnd: 400, railStart: 0, ...options };
}

describe('planTabReveal', () => {
    it('leaves a fully visible tab alone', () => {
        expect(
            planTabReveal(geometry({ scrollLeft: 120, tabStart: 50, tabEnd: 200 })),
        ).toBeUndefined();
    });

    it('scrolls the minimum that brings a tab overflowing on the right into view', () => {
        // The tab ends 60px past the rail, so the rail scrolls exactly 60px further and no more.
        expect(planTabReveal(geometry({ scrollLeft: 120, tabStart: 310, tabEnd: 460 }))).toBe(180);
    });

    it('aligns a tab overflowing on the left to the rail start', () => {
        expect(planTabReveal(geometry({ scrollLeft: 120, tabStart: -40, tabEnd: 110 }))).toBe(80);
    });

    it('aligns a tab wider than the rail to its start so the filename stays readable', () => {
        expect(planTabReveal(geometry({ scrollLeft: 100, tabStart: -30, tabEnd: 520 }))).toBe(70);
    });

    it('leaves a tab wider than the rail alone once its start is already aligned', () => {
        expect(
            planTabReveal(geometry({ scrollLeft: 100, tabStart: 0, tabEnd: 550 })),
        ).toBeUndefined();
    });

    it('ignores sub-pixel overflow so a resize callback cannot feed itself', () => {
        expect(
            planTabReveal(geometry({ scrollLeft: 120, tabStart: 50, tabEnd: 400.4 })),
        ).toBeUndefined();
        expect(
            planTabReveal(geometry({ scrollLeft: 120, tabStart: -0.4, tabEnd: 150 })),
        ).toBeUndefined();
    });

    it('reports nothing while the tab still has the zero width of its enter animation', () => {
        // The bug this module exists for: revealing against a 0px box computes a near-zero delta and leaves the tab
        // off-screen once the animation widens it. Callers re-run on resize; this frame must not claim success.
        expect(
            planTabReveal(geometry({ scrollLeft: 0, tabStart: 400, tabEnd: 400 })),
        ).toBeUndefined();
    });

    it('reports nothing for a rail that has not been laid out yet', () => {
        expect(
            planTabReveal({ railEnd: 0, railStart: 0, scrollLeft: 0, tabEnd: 10, tabStart: 0 }),
        ).toBeUndefined();
    });
});
