import { describe, expect, it } from 'vitest';

import { SPIN_CLOCK_MS, spinDegrees } from '../spin-phase';

describe('spinDegrees', () => {
    it('turns a 1 s ring three times per clock cycle', () => {
        expect(spinDegrees(0, 1_000)).toBe(0);
        expect(spinDegrees(0.25 / 3, 1_000)).toBeCloseTo(90);
        expect(spinDegrees(0.5, 1_000)).toBeCloseTo(180);
    });

    it('turns a ring whose period is the whole cycle once', () => {
        expect(spinDegrees(0.5, SPIN_CLOCK_MS)).toBeCloseTo(180);
    });

    it('stays below a full turn and matches 0° where the clock wraps', () => {
        expect(spinDegrees(1, 1_000)).toBeCloseTo(0);
        expect(spinDegrees(0.9999, 1_000)).toBeLessThan(360);
    });
});
