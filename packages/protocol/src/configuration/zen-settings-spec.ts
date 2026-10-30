import type { SettingSpec } from './settings-spec.js';

/**
 * Zen Mode's settings, kept beside the main catalog so `settingsSpec` stays within the source-size ratchet. Both
 * defaults follow VS Code's `zenMode.fullScreen` and `zenMode.restore`.
 */
export const zenSettingsSpec = [
    {
        kind: 'boolean',
        key: 'zen.fullScreen',
        title: 'Enter full screen with Zen Mode',
        description: 'Zen Mode also enters native full screen.',
        category: 'general',
        keywords: ['zen', 'focus', 'full screen', 'fullscreen', 'distraction'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'zen.restore',
        title: 'Restore Zen Mode on launch',
        description: 'Start in Zen Mode when it was on at quit.',
        category: 'general',
        keywords: ['zen', 'focus', 'restore', 'restart', 'startup', 'launch'],
        default: true,
    },
] as const satisfies readonly SettingSpec[];
