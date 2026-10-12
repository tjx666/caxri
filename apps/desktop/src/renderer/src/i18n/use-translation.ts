import { useMemo } from 'react';

import type { AppLocale } from '@caxri/protocol';
import type { TranslationParameters } from '@desktop-shared/i18n/interpolate';
import { interpolate } from '@desktop-shared/i18n/interpolate';
import type { TranslationKey as LobeTranslationKey } from '@lobehub/ui/i18n';
import { useTranslation as useLobeTranslation } from '@lobehub/ui/i18n';

import type { TranslationKey } from './resources';

export type Translate = (key: TranslationKey, parameters?: TranslationParameters) => string;

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
            t: (key, parameters) => interpolate(lookup(key as LobeTranslationKey), parameters),
        }),
        [locale, lookup],
    );
}
