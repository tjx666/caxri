import type { AppLocale } from '@caxri/protocol';
import type { TranslationKey as LobeTranslationKey, TranslationResources } from '@lobehub/ui/i18n';
import { en as lobeEn, zhCn as lobeZhCn } from '@lobehub/ui/i18n';

import { enResources } from './locales/en';
import { zhCNResources } from './locales/zh-cn';

/**
 * Every key the interface can translate: Caxri's own English source keys plus the built-in `@lobehub/ui` keys
 * (`common.cancel`, `common.confirm`, ...), which ship English and Simplified Chinese text of their own.
 */
export type TranslationKey = keyof typeof enResources | LobeTranslationKey;

/**
 * One flat dictionary per locale. `@lobehub/ui`'s built-ins come first so a Caxri key could override one, although the
 * resource test forbids that overlap to keep each key owned by exactly one source.
 */
export const localeDictionaries: Readonly<
    Record<AppLocale, Readonly<Partial<Record<string, string>>>>
> = {
    'en': { ...flattenLobe(lobeEn), ...enResources },
    'zh-CN': { ...flattenLobe(lobeZhCn), ...zhCNResources },
};

/**
 * The same dictionaries in the `resources` shape `@lobehub/ui`'s provider accepts. Its type only names the library's
 * own keys, while lookup is a plain string index, so Caxri's keys pass through the cast unchanged.
 */
export const lobeResources = {
    'en': [localeDictionaries.en],
    'zh-CN': [localeDictionaries['zh-CN']],
} satisfies Record<AppLocale, TranslationResources[]>;

function flattenLobe(namespaces: Readonly<Record<string, Readonly<Record<string, string>>>>) {
    return Object.assign({}, ...Object.values(namespaces)) as Record<string, string>;
}

/**
 * Narrows a key assembled at runtime from an open-ended id (a command registered by a feature module, an extension's
 * contribution) whose translation may not exist. Prefer a template literal over a closed id union, which type-checks
 * completeness instead; reach for this guard only when the id set is not a closed union.
 */
export function isTranslationKey(key: string): key is TranslationKey {
    return Object.hasOwn(localeDictionaries.en, key);
}
