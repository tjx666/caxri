import type { SettingSpec } from './settings-spec.js';

/**
 * Display languages the Renderer ships translations for. `null` (the setting's default) follows the system language.
 */
export const appLocales = ['en', 'zh-CN'] as const;

export type AppLocale = (typeof appLocales)[number];

/**
 * Resolves a language preference to the locale Caxri renders in. `null` (the default) follows the system: any Chinese
 * preference selects Simplified Chinese because it is the only Chinese translation shipped, and every other language
 * falls back to English. Desktop Main, the Renderer, and the phone share this so every surface agrees.
 */
export function resolveAppLocale(
    preference: AppLocale | null | undefined,
    systemLanguages: readonly string[],
): AppLocale {
    if (preference) return preference;
    const primary = systemLanguages.at(0)?.toLowerCase();
    return primary?.startsWith('zh') ? 'zh-CN' : 'en';
}

/**
 * The interface language setting, kept beside the main catalog so `settingsSpec` stays within the source-size ratchet.
 * `settingsSpec` spreads it first, so Language leads the General category.
 */
export const languageSettingsSpec = [
    {
        kind: 'enum',
        key: 'workbench.language',
        title: 'Language',
        description: 'Follow system picks Chinese on a Chinese system.',
        category: 'general',
        keywords: [
            'language',
            'locale',
            'i18n',
            'translation',
            'chinese',
            '中文',
            '语言',
            'english',
        ],
        // Each language is named in itself so it stays recognizable while the interface shows a language the reader
        // cannot read.
        options: [
            { value: 'en', label: 'English' },
            { value: 'zh-CN', label: '简体中文' },
        ],
        nullLabel: 'Follow system',
        default: null,
    },
    {
        kind: 'boolean',
        key: 'notifications.worktreeFallback',
        title: 'Worktree fallback reminders',
        description:
            'Show a popup when an unavailable worktree returns to its Project. Turn on to restore muted reminders. Applies to all Projects; recent events remain in Notifications.',
        category: 'notifications',
        keywords: ['mute', 'unmute', 'silent', 'reminder', 'notification'],
        default: true,
    },
    {
        kind: 'boolean',
        key: 'notifications.agentRecovery',
        title: 'Automatic Agent recovery reminders',
        description:
            'Show a popup after automatic Agent recovery. Turn on to restore muted reminders. Applies to all Projects; failures always appear.',
        category: 'notifications',
        keywords: ['mute', 'unmute', 'silent', 'reminder', 'notification'],
        default: true,
    },
] as const satisfies readonly SettingSpec[];
