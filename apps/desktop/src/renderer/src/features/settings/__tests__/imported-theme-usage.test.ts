import { describe, expect, it } from 'vitest';

import { importedThemeUses } from '../imported-theme-usage';

const base = {
    currentThemeId: 'mine',
    isFollowingSystem: false,
    lightThemeId: 'mine',
    darkThemeId: 'mine',
};

describe('importedThemeUses', () => {
    it('reports only the current theme in single-theme mode', () => {
        expect(importedThemeUses('mine', base)).toEqual(['current']);
        expect(importedThemeUses('other', base)).toEqual([]);
    });

    it('reports only the slots that name the theme while following the system', () => {
        const following = { ...base, isFollowingSystem: true };
        expect(importedThemeUses('mine', following)).toEqual(['light', 'dark']);
        expect(importedThemeUses('mine', { ...following, darkThemeId: 'x' })).toEqual(['light']);
        expect(importedThemeUses('mine', { ...following, lightThemeId: 'x' })).toEqual(['dark']);
        expect(
            importedThemeUses('mine', { ...following, lightThemeId: 'x', darkThemeId: 'y' }),
        ).toEqual([]);
    });
});
