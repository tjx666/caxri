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

export interface ThemeAppearanceSettings {
    'workbench.theme.followSystem': boolean;
    'workbench.theme.light': string;
    'workbench.theme.dark': string;
}

/**
 * The theme a window paints. `theme` is the persisted `theme.json`, which stays the user's explicit choice; while
 * "Follow system appearance" is on, the preset paired with the system appearance replaces it for display only, so a
 * system switch never rewrites `theme.json` or broadcasts a file change. An id that no longer names a preset keeps the
 * persisted theme rather than painting nothing.
 */
export function resolveEffectiveTheme(
    theme: ThemeTokens,
    appearance: ThemeAppearanceSettings,
    systemScheme: SystemColorScheme,
): ThemeTokens {
    if (!appearance['workbench.theme.followSystem']) return theme;
    const id =
        systemScheme === 'light'
            ? appearance['workbench.theme.light']
            : appearance['workbench.theme.dark'];
    return builtinThemes.find((candidate) => candidate.id === id) ?? theme;
}
