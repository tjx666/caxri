import type { AppLocale, TranslationParameters } from '@caxri/protocol';
import { interpolate, resolveAppLocale } from '@caxri/protocol';

import { commands as enCommands } from '../shared/i18n/en/commands';
import { desktop as enDesktop } from '../shared/i18n/en/desktop';
import { commands as zhCNCommands } from '../shared/i18n/zh-cn/commands';
import { desktop as zhCNDesktop } from '../shared/i18n/zh-cn/desktop';

const dictionaries = {
    'en': { ...enCommands, ...enDesktop },
    'zh-CN': { ...zhCNCommands, ...zhCNDesktop },
} satisfies Record<AppLocale, Record<string, string>>;

/**
 * Keys Main can translate: its own native menu and dialog copy plus the command titles it shares with the Renderer.
 */
export type MainTranslationKey = keyof typeof dictionaries.en;

/**
 * The `workbench.language` setting and `app.getLocale()` as of the last menu refresh. Injected rather than read here so
 * the pure prompt builders that call {@link translateMain} stay importable in Vitest without an Electron `app`.
 */
const language: { preference: AppLocale | null; systemLanguages: readonly string[] } = {
    preference: null,
    systemLanguages: [],
};

/**
 * Records the `workbench.language` setting. Main reads it with every native menu refresh, which `settings.changed`
 * triggers, so the menu bar rebuilds in the new language and later dialogs open in it.
 */
export function setMainLanguage(
    nextPreference: AppLocale | null,
    nextSystemLanguages: readonly string[],
): void {
    language.preference = nextPreference;
    language.systemLanguages = nextSystemLanguages;
}

export function mainLocale(): AppLocale {
    return resolveAppLocale(language.preference, language.systemLanguages);
}

/**
 * Translates native UI copy into the locale the `workbench.language` setting selects, so the menu bar and native
 * dialogs speak the same language as the window they belong to.
 */
export function translateMain(key: MainTranslationKey, parameters?: TranslationParameters): string {
    return interpolate(dictionaries[mainLocale()][key], parameters);
}

/**
 * Looks up a command title that may come from an id without a translation (a command added to the catalog before its
 * translation), falling back to the catalog's English title.
 */
export function translateCommandTitle(commandId: string, englishTitle: string): string {
    const key = `commands.${commandId}`;
    const dictionary: Partial<Record<string, string>> = dictionaries[mainLocale()];
    return dictionary[key] ?? englishTitle;
}
