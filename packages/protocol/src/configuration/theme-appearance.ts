import { contrastRatio } from '@caxri/utils';
import { z } from 'zod';

import type { ThemeTokens } from '../domain/domain.js';
import type { BuiltinThemeId } from './builtin-themes/index.js';
import { builtinThemes } from './builtin-themes/index.js';

export const systemColorSchemeSchema = z.enum(['light', 'dark']);
export type SystemColorScheme = z.infer<typeof systemColorSchemeSchema>;

/**
 * The appearance each built-in preset belongs to, which decides the list it appears in under "Follow system
 * appearance". Declared per id rather than derived from a luminance threshold so a mid-tone preset cannot flip lists
 * when a color is retuned; `theme-appearance.test.ts` pins every entry against the preset's actual canvas luminance.
 */
export const builtinThemeColorSchemes = {
    'dracula': 'dark',
    'monokai': 'dark',
    'one-dark-pro': 'dark',
    'solarized-dark': 'dark',
    'solarized-light': 'light',
    'tokyo-night': 'dark',
    'oscura-midnight': 'dark',
    'vscode-dark-plus': 'dark',
    'vscode-light-plus': 'light',
} as const satisfies Record<BuiltinThemeId, SystemColorScheme>;

export const defaultLightThemeId = 'vscode-light-plus' as const satisfies BuiltinThemeId;
export const defaultDarkThemeId = 'dracula' as const satisfies BuiltinThemeId;

/**
 * Ids of the built-in presets of one appearance, in picker order.
 */
export function builtinThemeIdsForScheme(scheme: SystemColorScheme): BuiltinThemeId[] {
    return builtinThemes
        .map((theme) => theme.id as BuiltinThemeId)
        .filter((id) => builtinThemeColorSchemes[id] === scheme);
}

/**
 * Imported themes kept beside `theme.json` so the "Follow system appearance" slots can name them. Bounded so a profile
 * cannot grow an unbounded catalog that every window loads.
 */
export const MAX_IMPORTED_THEMES = 50;
/**
 * Ids of imported themes start with this prefix, so one can never shadow a built-in preset.
 */
export const IMPORTED_THEME_ID_PREFIX = 'imported-';

/**
 * The appearance a theme belongs to: its declared one for a built-in preset, otherwise whichever of black or white text
 * reads better on its canvas, the same question a theme author answers when choosing light or dark.
 */
export function themeColorScheme(theme: ThemeTokens): SystemColorScheme {
    const declared = (builtinThemeColorSchemes as Partial<Record<string, SystemColorScheme>>)[
        theme.id
    ];
    if (declared) return declared;
    const { background } = theme.colors;
    return contrastRatio(background, '#000000') > contrastRatio(background, '#ffffff')
        ? 'light'
        : 'dark';
}

/**
 * The default preset of one appearance, which a slot falls back to when the theme it names is gone.
 */
export function defaultThemeIdForScheme(scheme: SystemColorScheme): BuiltinThemeId {
    return scheme === 'light' ? defaultLightThemeId : defaultDarkThemeId;
}

/**
 * What a light or dark slot can name, in picker order: the built-in presets of that appearance, then the imported
 * themes that read as it. The Theme tab and the General tab's Light theme and Dark theme rows list exactly these.
 */
export function themeSlotOptions(
    scheme: SystemColorScheme,
    imported: readonly ThemeTokens[],
): Array<{ id: string; name: string }> {
    return [
        ...builtinThemeIdsForScheme(scheme).map((id) => ({
            id,
            name: builtinThemes.find((theme) => theme.id === id)?.name ?? id,
        })),
        ...imported
            .filter((theme) => themeColorScheme(theme) === scheme)
            .map(({ id, name }) => ({ id, name })),
    ];
}

export interface ThemeAppearanceSettings {
    'workbench.theme.followSystem': boolean;
    'workbench.theme.light': string;
    'workbench.theme.dark': string;
}

/**
 * The theme a window paints. `theme` is the persisted `theme.json`, which stays the user's explicit choice; while
 * "Follow system appearance" is on, the theme paired with the system appearance replaces it for display only, so a
 * system switch never rewrites `theme.json` or broadcasts a file change. A slot may name a built-in preset or one of
 * the `imported` themes; an id that names neither (an imported theme deleted outside Caxri) paints that appearance's
 * default preset, so the window still follows the system.
 */
export function resolveEffectiveTheme(
    theme: ThemeTokens,
    appearance: ThemeAppearanceSettings,
    systemScheme: SystemColorScheme,
    imported: readonly ThemeTokens[] = [],
): ThemeTokens {
    if (!appearance['workbench.theme.followSystem']) return theme;
    const id =
        systemScheme === 'light'
            ? appearance['workbench.theme.light']
            : appearance['workbench.theme.dark'];
    const fallbackId = defaultThemeIdForScheme(systemScheme);
    return (
        builtinThemes.find((candidate) => candidate.id === id) ??
        imported.find((candidate) => candidate.id === id) ??
        builtinThemes.find((candidate) => candidate.id === fallbackId) ??
        theme
    );
}
