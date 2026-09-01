const RELATIVE_TIME_RANGES: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
];

type RelativeTimeFormatConstructor = typeof Intl.RelativeTimeFormat;

const fallbackRelativeTime = (value: number, unit: Intl.RelativeTimeFormatUnit): string => {
    if (value === 0) return unit === 'second' ? 'now' : `this ${unit}`;
    if (value === -1 && unit === 'day') return 'yesterday';
    if (value === 1 && unit === 'day') return 'tomorrow';
    if (value === -1 && (unit === 'month' || unit === 'year')) return `last ${unit}`;
    if (value === 1 && (unit === 'month' || unit === 'year')) return `next ${unit}`;

    const absoluteValue = Math.abs(value);
    const label = `${absoluteValue} ${unit}${absoluteValue === 1 ? '' : 's'}`;
    return value < 0 ? `${label} ago` : `in ${label}`;
};

/**
 * Uses the native formatter when available and preserves the same English output on runtimes such as Hermes that do not
 * provide `Intl.RelativeTimeFormat`. Construction is lazy so importing `@caxri/utils` remains portable even when
 * callers do not use relative-time formatting.
 */
const createRelativeTimeFormatter = () => {
    let cachedConstructor: RelativeTimeFormatConstructor | undefined;
    let cachedFormatter: Intl.RelativeTimeFormat | undefined;

    return (value: number, unit: Intl.RelativeTimeFormatUnit): string => {
        const Constructor = Intl.RelativeTimeFormat as RelativeTimeFormatConstructor | undefined;
        if (Constructor !== cachedConstructor) {
            cachedConstructor = Constructor;
            cachedFormatter = Constructor ? new Constructor('en', { numeric: 'auto' }) : undefined;
        }
        return cachedFormatter?.format(value, unit) ?? fallbackRelativeTime(value, unit);
    };
};

const formatRelativeTime = createRelativeTimeFormatter();

/**
 * Formats a past or future timestamp relative to now, e.g. "3 minutes ago" or "in 2 days".
 *
 * @param timestamp - Epoch milliseconds of the moment to describe.
 * @param now - Epoch milliseconds to measure from; injectable for deterministic tests.
 */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
    const seconds = Math.round((timestamp - now) / 1_000);
    for (const [unit, size] of RELATIVE_TIME_RANGES) {
        if (Math.abs(seconds) >= size) return formatRelativeTime(Math.round(seconds / size), unit);
    }
    return formatRelativeTime(seconds, 'second');
}
