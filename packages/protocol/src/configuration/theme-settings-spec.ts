import type { SettingSpec } from './settings-spec.js';

/**
 * "Follow system appearance" and its light/dark preset pair, modeled on VS Code's `window.autoDetectColorScheme` with
 * `workbench.preferredLightColorTheme` and `workbench.preferredDarkColorTheme`. Options are literal so the schema keeps
 * literal unions; `theme-appearance.test.ts` pins them to `builtinThemeColorSchemes`. Kept beside the main catalog so
 * `settingsSpec` stays within the source-size ratchet. The flag defaults to `false` here and is switched on once, when
 * the Server creates `theme.json` for a profile that never chose a theme.
 */
export const themeSettingsSpec = [
    {
        kind: 'boolean',
        key: 'workbench.theme.followSystem',
        title: 'Follow system appearance',
        description:
            'Uses the light theme when the system appearance is light and the dark theme when it is dark, switching live. Choosing a single theme in the Theme tab turns this off.',
        category: 'general',
        keywords: ['theme', 'appearance', 'dark', 'light', 'auto', 'system', 'mode', 'color'],
        default: false,
    },
    {
        kind: 'enum',
        key: 'workbench.theme.light',
        title: 'Light theme',
        description: 'Theme used while the system appearance is light',
        category: 'general',
        keywords: ['theme', 'appearance', 'light', 'preferred', 'color'],
        options: [
            { value: 'vscode-light-plus', label: 'VS Code Light+' },
            { value: 'solarized-light', label: 'Solarized Light' },
        ],
        default: 'vscode-light-plus',
    },
    {
        kind: 'enum',
        key: 'workbench.theme.dark',
        title: 'Dark theme',
        description: 'Theme used while the system appearance is dark',
        category: 'general',
        keywords: ['theme', 'appearance', 'dark', 'preferred', 'color'],
        options: [
            { value: 'dracula', label: 'Dracula' },
            { value: 'monokai', label: 'Monokai' },
            { value: 'one-dark-pro', label: 'One Dark Pro' },
            { value: 'solarized-dark', label: 'Solarized Dark' },
            { value: 'tokyo-night', label: 'Tokyo Night' },
            { value: 'oscura-midnight', label: 'Oscura Midnight' },
            { value: 'vscode-dark-plus', label: 'VS Code Dark+' },
        ],
        default: 'dracula',
    },
] as const satisfies readonly SettingSpec[];
