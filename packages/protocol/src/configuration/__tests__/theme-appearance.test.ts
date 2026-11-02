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
    themeColorScheme,
    themeSlotOptions,
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

    it('paints an imported theme a slot names', () => {
        const imported = { ...solarizedLightTheme, id: 'imported-paper', name: 'Paper' };
        expect(
            resolveEffectiveTheme(
                draculaTheme,
                { ...following, 'workbench.theme.light': 'imported-paper' },
                'light',
                [imported],
            ),
        ).toBe(imported);
    });

    it("falls back to the appearance's default preset when a slot names a theme that is gone", () => {
        expect(
            resolveEffectiveTheme(
                draculaTheme,
                { ...following, 'workbench.theme.light': 'imported-removed' },
                'light',
            ),
        ).toBe(vscodeLightPlusTheme);
        expect(
            resolveEffectiveTheme(
                solarizedLightTheme,
                { ...following, 'workbench.theme.dark': 'imported-removed' },
                'dark',
            ),
        ).toBe(draculaTheme);
    });
});

describe('themeSlotOptions', () => {
    it('lists the presets of an appearance, then the imported themes that read as it', () => {
        const paper = { ...solarizedLightTheme, id: 'imported-paper', name: 'Paper' };
        const night = { ...draculaTheme, id: 'imported-night', name: 'Night' };
        expect(themeSlotOptions('light', [night, paper])).toEqual([
            ...builtinThemeIdsForScheme('light').map((id) => ({
                id,
                name: builtinThemes.find((theme) => theme.id === id)?.name,
            })),
            { id: 'imported-paper', name: 'Paper' },
        ]);
        expect(themeSlotOptions('dark', [night, paper]).at(-1)).toEqual({
            id: 'imported-night',
            name: 'Night',
        });
    });
});

describe('themeColorScheme', () => {
    it('reads an imported theme as light or dark from its canvas', () => {
        expect(themeColorScheme({ ...vscodeLightPlusTheme, id: 'imported-a' })).toBe('light');
        expect(themeColorScheme({ ...draculaTheme, id: 'imported-b' })).toBe('dark');
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

    it('lets a slot name an imported theme but not an empty or unbounded id', () => {
        expect(
            appSettingsSchema.parse({ 'workbench.theme.light': 'imported-paper' })[
                'workbench.theme.light'
            ],
        ).toBe('imported-paper');
        expect(() => appSettingsSchema.parse({ 'workbench.theme.dark': ' ' })).toThrow();
        expect(() =>
            appSettingsSchema.parse({ 'workbench.theme.dark': 'x'.repeat(129) }),
        ).toThrow();
    });
});
