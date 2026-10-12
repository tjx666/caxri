import type { AppLocale } from '@caxri/protocol';

/**
 * Resolves the `workbench.language` setting to the locale Caxri renders in. `null` (the default) follows the system:
 * any Chinese preference selects Simplified Chinese because it is the only Chinese translation shipped, and every other
 * language falls back to English. Main and the Renderer share this so the menu bar and the window agree.
 */
export function resolveAppLocale(
    preference: AppLocale | null | undefined,
    systemLanguages: readonly string[],
): AppLocale {
    if (preference) return preference;
    const primary = systemLanguages.at(0)?.toLowerCase();
    return primary?.startsWith('zh') ? 'zh-CN' : 'en';
}
