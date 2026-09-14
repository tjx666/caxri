/**
 * The built-in theme catalog. Each palette lives in its own file beside this one: the eight are independent data blobs
 * that grow together whenever a color role is added, so keeping them in one module made that file collide with the
 * repository's per-file line limit every time the palette widened.
 */
import type { ThemeTokens } from '../../domain/domain.js';

export { draculaTheme } from './dracula.js';
export { monokaiTheme } from './monokai.js';
export { oneDarkProTheme } from './one-dark-pro.js';
export { oscuraMidnightTheme } from './oscura-midnight.js';
export { solarizedDarkTheme, solarizedLightTheme } from './solarized.js';
export { tokyoNightTheme } from './tokyo-night.js';
export { vscodeDarkPlusTheme } from './vscode-dark-plus.js';

import { draculaTheme } from './dracula.js';
import { monokaiTheme } from './monokai.js';
import { oneDarkProTheme } from './one-dark-pro.js';
import { oscuraMidnightTheme } from './oscura-midnight.js';
import { solarizedDarkTheme, solarizedLightTheme } from './solarized.js';
import { tokyoNightTheme } from './tokyo-night.js';
import { vscodeDarkPlusTheme } from './vscode-dark-plus.js';

/**
 * Stable user-facing order for the built-in theme picker.
 */
export const builtinThemes = [
    draculaTheme,
    monokaiTheme,
    oneDarkProTheme,
    solarizedDarkTheme,
    solarizedLightTheme,
    tokyoNightTheme,
    oscuraMidnightTheme,
    vscodeDarkPlusTheme,
] as const satisfies readonly ThemeTokens[];

export const builtinThemeIds = [
    'dracula',
    'monokai',
    'one-dark-pro',
    'solarized-dark',
    'solarized-light',
    'tokyo-night',
    'oscura-midnight',
    'vscode-dark-plus',
] as const;

export type BuiltinThemeId = (typeof builtinThemeIds)[number];

export const builtinThemeSources = {
    'dracula': {
        license: 'MIT',
        url: 'https://github.com/dracula/dracula-theme',
    },
    'monokai': {
        license: 'MIT',
        url: 'https://github.com/microsoft/vscode/blob/main/extensions/theme-monokai/themes/monokai-color-theme.json',
    },
    'one-dark-pro': {
        license: 'MIT',
        url: 'https://github.com/Binaryify/OneDark-Pro/blob/master/themes/OneDark-Pro.json',
    },
    'solarized-dark': {
        license: 'MIT',
        url: 'https://github.com/microsoft/vscode/blob/main/extensions/theme-solarized-dark/themes/solarized-dark-color-theme.json',
    },
    'solarized-light': {
        license: 'MIT',
        url: 'https://github.com/microsoft/vscode/blob/main/extensions/theme-solarized-light/themes/solarized-light-color-theme.json',
    },
    'tokyo-night': {
        license: 'MIT',
        url: 'https://github.com/tokyo-night/tokyo-night-vscode-theme/blob/master/themes/tokyo-night-color-theme.json',
    },
    'oscura-midnight': {
        license: 'MIT',
        url: 'https://github.com/narative/oscura/blob/main/themes/oscura-midnight.json',
    },
    'vscode-dark-plus': {
        license: 'MIT',
        url: 'https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_plus.json',
    },
} as const satisfies Record<BuiltinThemeId, { license: 'MIT'; url: string }>;
