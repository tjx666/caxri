import { describe, expect, it } from 'vitest';

import {
    isTranslucentSidebarActive,
    translucentSidebarInactiveReason,
} from '../translucent-sidebar';

const DARK = '#282a36';
const LIGHT = '#ffffff';

describe('isTranslucentSidebarActive', () => {
    it('frosts the sidebar on macOS when the theme matches the system appearance', () => {
        const base = { isMacOS: true, isEnabled: true };
        expect(
            isTranslucentSidebarActive({
                ...base,
                themeBackground: DARK,
                isSystemDark: true,
                isFullScreen: false,
            }),
        ).toBe(true);
        expect(
            isTranslucentSidebarActive({
                ...base,
                themeBackground: LIGHT,
                isSystemDark: false,
                isFullScreen: false,
            }),
        ).toBe(true);
    });

    it('keeps the sidebar opaque when the material would wash the theme out', () => {
        const base = { isMacOS: true, isEnabled: true };
        expect(
            isTranslucentSidebarActive({
                ...base,
                themeBackground: DARK,
                isSystemDark: false,
                isFullScreen: false,
            }),
        ).toBe(false);
        expect(
            isTranslucentSidebarActive({
                ...base,
                themeBackground: LIGHT,
                isSystemDark: true,
                isFullScreen: false,
            }),
        ).toBe(false);
    });

    it('stays opaque off macOS, when turned off, or before the theme loads', () => {
        const matching = { themeBackground: DARK, isSystemDark: true, isFullScreen: false };
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
                isFullScreen: false,
            }),
        ).toBe(false);
    });
});

describe('full screen', () => {
    const base = { isMacOS: true, isEnabled: true, themeBackground: DARK, isSystemDark: true };

    it('stays opaque in full screen even when the theme matches the system', () => {
        expect(isTranslucentSidebarActive({ ...base, isFullScreen: true })).toBe(false);
        expect(isTranslucentSidebarActive({ ...base, isFullScreen: false })).toBe(true);
    });
});

describe('translucentSidebarInactiveReason', () => {
    const base = {
        isMacOS: true,
        isEnabled: true,
        themeBackground: DARK,
        isSystemDark: true,
        isFullScreen: false,
    };

    it('explains a dark theme over a light system and the inverse', () => {
        expect(translucentSidebarInactiveReason({ ...base, isSystemDark: false })).toBe(
            'themeDarkSystemLight',
        );
        expect(translucentSidebarInactiveReason({ ...base, themeBackground: LIGHT })).toBe(
            'themeLightSystemDark',
        );
    });

    it('explains full screen first', () => {
        expect(translucentSidebarInactiveReason({ ...base, isFullScreen: true })).toBe(
            'fullScreen',
        );
    });

    it('owes no explanation while frosted, off, off macOS, or before the theme loads', () => {
        expect(translucentSidebarInactiveReason(base)).toBeUndefined();
        expect(translucentSidebarInactiveReason({ ...base, isEnabled: false })).toBeUndefined();
        expect(
            translucentSidebarInactiveReason({ ...base, isMacOS: false, isSystemDark: false }),
        ).toBeUndefined();
        expect(
            translucentSidebarInactiveReason({ ...base, themeBackground: undefined }),
        ).toBeUndefined();
    });
});
