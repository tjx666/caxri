import {
    commandCategoryKey,
    commandDescriptionKey,
    commandTitleKey,
} from '@desktop-shared/i18n/command-keys';

import type { Translate } from '../i18n';
import { isTranslationKey } from '../i18n';

/**
 * Display helpers for command titles, categories, and descriptions. The protocol catalog keeps English copy as the
 * source and fallback; extension and View catalog commands carry open-ended ids, so every lookup goes through
 * `isTranslationKey` and falls back to the definition's own English text when no translation exists.
 */
export function commandTitle(command: { id: string; title: string }, t: Translate): string {
    const key = commandTitleKey(command.id);
    return isTranslationKey(key) ? t(key) : command.title;
}

export function commandCategory(category: string, t: Translate): string {
    const key = commandCategoryKey(category);
    return isTranslationKey(key) ? t(key) : category;
}

export function commandDescription(
    command: { id: string; description?: string },
    t: Translate,
): string | undefined {
    if (command.description === undefined) return undefined;
    const key = commandDescriptionKey(command.id);
    return isTranslationKey(key) ? t(key) : command.description;
}
