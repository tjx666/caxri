import type { AppLocale } from '@caxri/protocol';

import { useLocaleStore } from '../i18n';

/**
 * Number and date formatters in the interface language (`workbench.language`), not the system locale `undefined`
 * resolves to and not a hard-coded `en-US`: a Chinese interface on an English system should still group and date its
 * figures the Chinese way. The locale defaults to the store's current value, which the caller's `useTranslation()`
 * re-render keeps current, so a component that already re-renders on a language change formats in the new language.
 */

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

function currentLocale(): AppLocale {
    return useLocaleStore.getState().locale;
}

/**
 * A cached `Intl.NumberFormat` for the interface language.
 */
export function localeNumberFormat(
    options: Intl.NumberFormatOptions = {},
    locale: AppLocale = currentLocale(),
): Intl.NumberFormat {
    const key = `${locale}:${JSON.stringify(options)}`;
    let format = numberFormats.get(key);
    if (!format) {
        format = new Intl.NumberFormat(locale, options);
        numberFormats.set(key, format);
    }
    return format;
}

/**
 * A cached `Intl.DateTimeFormat` for the interface language, in the local time zone.
 */
export function localeDateTimeFormat(
    options: Intl.DateTimeFormatOptions,
    locale: AppLocale = currentLocale(),
): Intl.DateTimeFormat {
    const key = `${locale}:${JSON.stringify(options)}`;
    let format = dateTimeFormats.get(key);
    if (!format) {
        format = new Intl.DateTimeFormat(locale, options);
        dateTimeFormats.set(key, format);
    }
    return format;
}

/**
 * A whole count with the interface language's digit grouping: `12,345`.
 */
export function formatCount(count: number, locale: AppLocale = currentLocale()): string {
    return localeNumberFormat({}, locale).format(count);
}
