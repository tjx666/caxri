import { contrastRatio } from '@caxri/utils';
import { describe, expect, it } from 'vitest';

import { mobileTheme } from '../tokens';

const expectAccessibleContrast = (foreground: string, background: string): void => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
};

describe('mobileTheme', () => {
    it('keeps body and muted text readable on every content surface', () => {
        for (const surface of [mobileTheme.background, mobileTheme.surface]) {
            expectAccessibleContrast(mobileTheme.text, surface);
            expectAccessibleContrast(mobileTheme.muted, surface);
        }
    });

    it('keeps primary actions and danger states readable', () => {
        expectAccessibleContrast(mobileTheme.primaryForeground, mobileTheme.primary);
        expectAccessibleContrast(mobileTheme.danger, mobileTheme.background);
        expectAccessibleContrast(mobileTheme.danger, mobileTheme.surface);
    });
});
