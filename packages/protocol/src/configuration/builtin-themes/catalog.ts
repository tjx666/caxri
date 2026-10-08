/**
 * The catalog itself: picker order, the id union every other module keys off, and each palette's upstream source. The
 * palettes live one file each beside this one: eight independent data blobs that widen together every time a color role
 * is added, which is what had put the single-module version over the repository's per-file line limit.
 */
import type { ThemeTokens } from '../../domain/domain.js';
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
