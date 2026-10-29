import { useMemo } from 'react';

import type { AppLocale, TranslationParameters } from '@caxri/protocol';
import { interpolate } from '@caxri/protocol';
import type { TranslationKey as LobeTranslationKey } from '@lobehub/ui/i18n';
import { useTranslation as useLobeTranslation } from '@lobehub/ui/i18n';

import type { TranslationKey } from './resources';

/**
 * A message lookup that also carries the locale it translates into. Formatters take `t.locale` instead of reading the
 * global locale store, so a helper that already receives `t` stays a pure function of its inputs under React Compiler.
 */
export interface Translate {
    (key: TranslationKey, parameters?: TranslationParameters): string;
    readonly locale: AppLocale;
}

/**
 * Attaches the locale to a lookup function. Production code gets its `Translate` from `useTranslation()`; unit tests
 * use this to build a fake lookup that still satisfies the type.
 */
export function withLocale(
    lookup: (key: TranslationKey, parameters?: TranslationParameters) => string,
    locale: AppLocale = 'en',
): Translate {
    return Object.assign(
        (key: TranslationKey, parameters?: TranslationParameters) => lookup(key, parameters),
        {
            locale,
        },
    );
}

/**
 * Reads the active locale from `@lobehub/ui`'s i18n context and returns a typed `t` that also fills `{{name}}`
 * placeholders. Components re-render when the language changes because the context value changes with it.
 */
export function useTranslation(): { locale: AppLocale; t: Translate } {
    const { locale, t: lookup } = useLobeTranslation();
    return useMemo(
        () => ({
            locale: locale as AppLocale,
            // The library types `t` with its own built-in keys only; its lookup is a plain string index, so Caxri keys
            // resolve through it unchanged.
            t: withLocale(
                (key, parameters) => interpolate(lookup(key as LobeTranslationKey), parameters),
                locale as AppLocale,
            ),
        }),
        [locale, lookup],
    );
}
