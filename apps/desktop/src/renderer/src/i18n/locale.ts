import type { AppLocale } from '@caxri/protocol';

/**
 * Resolves the `workbench.language` setting to the locale the interface renders in. `null` (the default) follows the
 * system: any Chinese preference selects Simplified Chinese because it is the only Chinese translation shipped, and
 * every other language falls back to English.
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
 * The system's preferred languages as Chromium reports them. Electron derives `navigator.languages` from the macOS
 * language list, so this follows System Settings › Language & Region without a Main round trip.
 */
export function systemLanguages(): readonly string[] {
    // Node also defines `navigator`, reporting the host's locale, so a Vitest run on a Chinese-language machine would
    // otherwise render Chinese and diverge from CI. Outside a document the system language is treated as unknown.
    if (typeof document === 'undefined') return [];
    return navigator.languages;
}
