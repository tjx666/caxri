import type { AppLocale } from '@caxri/protocol';

/**
 * Number and date formatters in the interface language (`workbench.language`), not the system locale `undefined`
 * resolves to and not a hard-coded `en-US`: a Chinese interface on an English system should still group and date its
 * figures the Chinese way. The locale is a required argument, never read from the store here: React Compiler memoizes
 * render output by its inputs, so a formatter that read the global locale would keep the previous language after a
 * runtime language switch. Callers pass `locale` from `useTranslation()` or `t.locale`.
 */

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * A cached `Intl.NumberFormat` for the interface language.
 */
export function localeNumberFormat(
    options: Intl.NumberFormatOptions = {},
    locale: AppLocale,
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
    locale: AppLocale,
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
export function formatCount(count: number, locale: AppLocale): string {
    return localeNumberFormat({}, locale).format(count);
}

/**
 * A date and time in the interface language, the `toLocaleString()` shape (numeric date plus time with seconds).
 */
export function formatDateTime(value: number | Date, locale: AppLocale): string {
    return localeDateTimeFormat(
        {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
        },
        locale,
    ).format(value);
}

/**
 * A numeric date in the interface language, the `toLocaleDateString()` shape.
 */
export function formatDate(value: number | Date, locale: AppLocale): string {
    return localeDateTimeFormat(
        { year: 'numeric', month: 'numeric', day: 'numeric' },
        locale,
    ).format(value);
}

/**
 * A clock time in the interface language, without seconds unless `withSeconds` is set.
 */
export function formatTime(
    value: number | Date,
    options: { withSeconds?: boolean; twoDigitHour?: boolean },
    locale: AppLocale,
): string {
    return localeDateTimeFormat(
        {
            hour: options.twoDigitHour === true ? '2-digit' : 'numeric',
            minute: '2-digit',
            ...(options.withSeconds === true && { second: '2-digit' }),
        },
        locale,
    ).format(value);
}
