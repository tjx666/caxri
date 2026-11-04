import type { AppLocale } from '@caxri/protocol';

/**
 * Joins `items` into a readable list in `locale` ("a, b, and c" in English; "a、b 和 c" in Chinese), instead of a
 * hard-coded `', '` that reads wrong outside English.
 */
export function formatList(items: readonly string[], locale: AppLocale): string {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
}
