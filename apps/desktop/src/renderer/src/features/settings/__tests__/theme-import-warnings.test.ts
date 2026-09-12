import { describe, expect, it } from 'vitest';

import {
    dismissThemeImportWarning,
    readThemeImportWarningDismissals,
    resetThemeImportWarningDismissals,
    themeImportWarningDismissGeneration,
} from '../theme-import-warnings';

describe('theme import warning dismissals', () => {
    it('keeps dismissals for a theme across view remounts without affecting other themes', () => {
        const themeId = 'dismissal-persistence';
        resetThemeImportWarningDismissals(themeId);

        dismissThemeImportWarning(themeId, 'Unknown color');

        expect(readThemeImportWarningDismissals(themeId).has('Unknown color')).toBe(true);
        expect(readThemeImportWarningDismissals('another-theme').size).toBe(0);
    });

    it('clears prior dismissals and advances the generation for a same-id import', () => {
        const themeId = 'dismissal-reset';
        dismissThemeImportWarning(themeId, 'Unknown color');
        const before = themeImportWarningDismissGeneration(themeId);

        resetThemeImportWarningDismissals(themeId);

        expect(readThemeImportWarningDismissals(themeId).size).toBe(0);
        expect(themeImportWarningDismissGeneration(themeId)).toBe(before + 1);
    });
});
