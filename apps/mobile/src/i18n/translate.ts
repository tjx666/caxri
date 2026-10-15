import type { TranslationParameters } from '@caxri/protocol';
import { interpolate } from '@caxri/protocol';

import { getLocale } from './locale-store';
import type { TranslationKey } from './resources';
import { localeDictionaries } from './resources';

/**
 * Translates `key` into the active locale outside React. Components call `useTranslation()` instead, which re-renders
 * them when the language changes; a value computed here is a snapshot, so never call this at module top level.
 */
export function translate(key: TranslationKey, parameters?: TranslationParameters): string {
    const template = localeDictionaries[getLocale()][key] ?? localeDictionaries.en[key] ?? key;
    return interpolate(template, parameters);
}

export type Translate = typeof translate;
