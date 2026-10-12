import type { AppLocale } from '@caxri/protocol';
import type { RelativeTimeStyle } from '@caxri/utils';
import { relativeTime } from '@caxri/utils';

/**
 * The same unit thresholds `@caxri/utils`' `relativeTime` uses, so a localized label turns over at the same moments as
 * the English one.
 */
const RELATIVE_TIME_RANGES: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
];

const formatters = new Map<string, Intl.RelativeTimeFormat>();

function formatterFor(locale: AppLocale, style: RelativeTimeStyle): Intl.RelativeTimeFormat {
    const key = `${locale}:${style}`;
    let formatter = formatters.get(key);
    if (!formatter) {
        formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style });
        formatters.set(key, formatter);
    }
    return formatter;
}

/**
 * "3 minutes ago" in the interface language. English goes through the shared `relativeTime` unchanged, so its wording
 * stays byte-identical to every other surface; another locale uses Chromium's own `Intl.RelativeTimeFormat` wording ("3
 * 分钟前"), which the Renderer always has.
 */
export function localizedRelativeTime(
    timestamp: number,
    now: number,
    style: RelativeTimeStyle,
    locale: AppLocale,
): string {
    if (locale === 'en') return relativeTime(timestamp, now, style);
    const seconds = Math.round((timestamp - now) / 1_000);
    const formatter = formatterFor(locale, style);
    for (const [unit, size] of RELATIVE_TIME_RANGES)
        if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
    return formatter.format(seconds, 'second');
}
