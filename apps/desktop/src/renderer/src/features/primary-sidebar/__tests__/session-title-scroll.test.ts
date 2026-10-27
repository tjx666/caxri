import { describe, expect, it } from 'vitest';

import { sessionTitleScrollTimeline } from '../session-title-scroll';

describe('sessionTitleScrollTimeline', () => {
    it('keeps offsets non-decreasing when the fade ramp covers half the travel', () => {
        // A 3px overflow behind an 8px fade rounded fadeOut below fadeIn and made Element.animate throw.
        const { slideStart, fadeIn, fadeOut, slideEnd } = sessionTitleScrollTimeline(3, 8);
        expect(fadeOut).toBeGreaterThanOrEqual(fadeIn);
        expect([0, slideStart, fadeIn, fadeOut, slideEnd, 1]).toEqual(
            [0, slideStart, fadeIn, fadeOut, slideEnd, 1].toSorted((a, b) => a - b),
        );
    });

    it('keeps every offset ordered across overflow and fade widths', () => {
        for (const fade of [0, 8, 12, 16, 24, 40]) {
            for (let distance = 2; distance <= 400; distance += 0.5) {
                const { slideStart, fadeIn, fadeOut, slideEnd } = sessionTitleScrollTimeline(
                    distance,
                    fade,
                );
                const offsets = [0, slideStart, fadeIn, fadeOut, slideEnd, 1];
                for (let index = 1; index < offsets.length; index++) {
                    expect(offsets[index]).toBeGreaterThanOrEqual(offsets[index - 1]);
                }
            }
        }
    });

    it('ramps the edge fade over the fade width of travel', () => {
        const { duration, slideStart, fadeIn, fadeOut, slideEnd } = sessionTitleScrollTimeline(
            70,
            7,
        );
        expect(duration).toBe(600 + 2000 + 1200);
        expect(slideStart * duration).toBeCloseTo(600);
        expect(fadeIn * duration).toBeCloseTo(800);
        expect(fadeOut * duration).toBeCloseTo(2400);
        expect(slideEnd * duration).toBeCloseTo(2600);
    });
});
