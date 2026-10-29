import { contrastRatio } from '@caxri/utils';
import { describe, expect, it } from 'vitest';

import {
    builtinThemes,
    draculaTheme,
    solarizedLightTheme,
    vscodeLightPlusTheme,
} from '../builtin-themes/index.js';
import { appSettingsSchema } from '../settings-schema.js';
import { settingsSpecByKey } from '../settings-spec.js';
import {
    builtinThemeColorSchemes,
    builtinThemeIdsForScheme,
    defaultDarkThemeId,
    defaultLightThemeId,
    resolveEffectiveTheme,
} from '../theme-appearance.js';

const following = {
    'workbench.theme.followSystem': true,
    'workbench.theme.light': defaultLightThemeId,
    'workbench.theme.dark': defaultDarkThemeId,
} as const;

describe('resolveEffectiveTheme', () => {
    it('keeps the persisted theme while Follow system appearance is off', () => {
        const off = { ...following, 'workbench.theme.followSystem': false };
        expect(resolveEffectiveTheme(solarizedLightTheme, off, 'dark')).toBe(solarizedLightTheme);
        expect(resolveEffectiveTheme(solarizedLightTheme, off, 'light')).toBe(solarizedLightTheme);
    });

    it('pairs the system appearance with the configured light and dark presets', () => {
        expect(resolveEffectiveTheme(draculaTheme, following, 'light')).toBe(vscodeLightPlusTheme);
        expect(resolveEffectiveTheme(solarizedLightTheme, following, 'dark')).toBe(draculaTheme);
        expect(
            resolveEffectiveTheme(
                draculaTheme,
                { ...following, 'workbench.theme.light': 'solarized-light' },
                'light',
            ),
        ).toBe(solarizedLightTheme);
    });

    it('falls back to the persisted theme when a configured id names no preset', () => {
        expect(
            resolveEffectiveTheme(
                draculaTheme,
                { ...following, 'workbench.theme.light': 'removed-preset' },
                'light',
            ),
        ).toBe(draculaTheme);
    });
});

describe('theme appearance catalog', () => {
    it('declares an appearance for every preset that matches its canvas luminance', () => {
        expect(
            Object.keys(builtinThemeColorSchemes).toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(builtinThemes.map((theme) => theme.id).toSorted((a, b) => a.localeCompare(b)));
        for (const theme of builtinThemes) {
            const scheme =
                builtinThemeColorSchemes[theme.id as keyof typeof builtinThemeColorSchemes];
            const isLight = contrastRatio(theme.colors.background, '#000000') > 10;
            expect(scheme, theme.id).toBe(isLight ? 'light' : 'dark');
        }
    });

    it('offers each Settings picker exactly the presets of its appearance, and defaults to a matching one', () => {
        for (const scheme of ['light', 'dark'] as const) {
            const key = `workbench.theme.${scheme}` as const;
            expect(
                settingsSpecByKey[key].options
                    .map((option) => option.value)
                    .toSorted((a, b) => a.localeCompare(b)),
            ).toEqual(builtinThemeIdsForScheme(scheme).toSorted((a, b) => a.localeCompare(b)));
            expect(builtinThemeColorSchemes[settingsSpecByKey[key].default]).toBe(scheme);
        }
        expect(appSettingsSchema.parse({})['workbench.theme.followSystem']).toBe(false);
    });
});
