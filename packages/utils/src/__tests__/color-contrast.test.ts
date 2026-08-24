import { describe, expect, it } from 'vitest';

import { contrastRatio, relativeLuminance } from '../color-contrast';

describe('color contrast', () => {
    it('computes the WCAG luminance endpoints', () => {
        expect(relativeLuminance('#000000')).toBe(0);
        expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
        expect(relativeLuminance('#ffffff80')).toBeCloseTo(1, 5);
    });

    it('computes a symmetric contrast ratio', () => {
        expect(contrastRatio('#000000', '#ffffff')).toBe(21);
        expect(contrastRatio('#ffffff', '#000000')).toBe(21);
    });
});
