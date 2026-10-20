import { describe, expect, it } from 'vitest';

import { isTranslucentSidebarActive } from '../translucent-sidebar';

const DARK = '#282a36';
const LIGHT = '#ffffff';

describe('isTranslucentSidebarActive', () => {
    it('frosts the sidebar on macOS when the theme matches the system appearance', () => {
        const base = { isMacOS: true, isEnabled: true };
        expect(
            isTranslucentSidebarActive({ ...base, themeBackground: DARK, isSystemDark: true }),
        ).toBe(true);
        expect(
            isTranslucentSidebarActive({ ...base, themeBackground: LIGHT, isSystemDark: false }),
        ).toBe(true);
    });

    it('keeps the sidebar opaque when the material would wash the theme out', () => {
        const base = { isMacOS: true, isEnabled: true };
        expect(
            isTranslucentSidebarActive({ ...base, themeBackground: DARK, isSystemDark: false }),
        ).toBe(false);
        expect(
            isTranslucentSidebarActive({ ...base, themeBackground: LIGHT, isSystemDark: true }),
        ).toBe(false);
    });

    it('stays opaque off macOS, when turned off, or before the theme loads', () => {
        const matching = { themeBackground: DARK, isSystemDark: true };
        expect(isTranslucentSidebarActive({ ...matching, isMacOS: false, isEnabled: true })).toBe(
            false,
        );
        expect(isTranslucentSidebarActive({ ...matching, isMacOS: true, isEnabled: false })).toBe(
            false,
        );
        expect(
            isTranslucentSidebarActive({
                isMacOS: true,
                isEnabled: true,
                themeBackground: undefined,
                isSystemDark: true,
            }),
        ).toBe(false);
    });
});
