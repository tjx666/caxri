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
        description:
            'Zen Mode also puts the window in native full screen, and leaving Zen Mode leaves full screen again unless the window was already full screen.',
        category: 'general',
        keywords: ['zen', 'focus', 'full screen', 'fullscreen', 'distraction'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'zen.restore',
        title: 'Restore Zen Mode on launch',
        description:
            'Reopening Caxri while Zen Mode was on starts in Zen Mode again. Turn off to always start with the full layout.',
        category: 'general',
        keywords: ['zen', 'focus', 'restore', 'restart', 'startup', 'launch'],
        default: true,
    },
] as const satisfies readonly SettingSpec[];
