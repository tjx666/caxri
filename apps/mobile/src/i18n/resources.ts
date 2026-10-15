import type { AppLocale } from '@caxri/protocol';

import { enResources } from './locales/en';
import { zhCNResources } from './locales/zh-cn';

/**
 * Every key the phone can translate, from its English source modules.
 */
export type TranslationKey = keyof typeof enResources;

/**
 * One flat dictionary per locale. The resource test keeps both locales on the same key set and placeholders.
 */
export const localeDictionaries: Readonly<
    Record<AppLocale, Readonly<Partial<Record<string, string>>>>
> = {
    'en': enResources,
    'zh-CN': zhCNResources,
};
