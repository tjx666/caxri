import { contrastRatio } from '@caxri/utils';
import { describe, expect, it } from 'vitest';

import { diffStatColors, oklchLightness } from '../diff-stat-colors';

describe('diffStatColors', () => {
    it('moves an unbalanced pair to one shared lightness', () => {
        // Dracula's success / danger: L 0.87 and 0.68.
        const { added, removed } = diffStatColors('#50fa7b', '#ff5555');
        expect(oklchLightness(added)).toBeCloseTo(0.775, 2);
        expect(oklchLightness(removed)).toBeCloseTo(0.775, 2);
    });

    it('keeps each hue, so added stays green and removed stays red', () => {
        const { added, removed } = diffStatColors('#50fa7b', '#ff5555');
        const channels = (hex: string) =>
            [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
        const [addedRed, addedGreen] = channels(added);
        const [removedRed, removedGreen] = channels(removed);
        expect(addedGreen).toBeGreaterThan(addedRed);
        expect(removedRed).toBeGreaterThan(removedGreen);
    });

    it('returns in-gamut hex for dark and light pairs', () => {
        for (const [success, danger] of [
            ['#50fa7b', '#ff5555'],
            ['#859900', '#dc322f'],
            ['#00ff00', '#ff0000'],
        ]) {
            const { added, removed } = diffStatColors(success, danger);
            expect(added).toMatch(/^#[\da-f]{6}$/);
            expect(removed).toMatch(/^#[\da-f]{6}$/);
            expect(Math.abs(oklchLightness(added) - oklchLightness(removed))).toBeLessThan(0.02);
            expect(contrastRatio(added, removed)).toBeLessThan(1.2);
        }
    });
});
