const RELATIVE_TIME_RANGES: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
];

type RelativeTimeFormatConstructor = typeof Intl.RelativeTimeFormat;

/**
 * How long the label is allowed to be. `long` reads as prose ("8 minutes ago"); `narrow` is the dense-list form ("8m
 * ago") for a row that has to fit a name, a state, and a time inside a side bar.
 */
export type RelativeTimeStyle = 'long' | 'narrow';

/**
 * Matches `Intl`'s own `narrow` abbreviations so the fallback below reads the same on a runtime without the formatter.
 */
const NARROW_UNITS: Record<Intl.RelativeTimeFormatUnit, string> = {
    day: 'd',
    days: 'd',
    hour: 'h',
    hours: 'h',
    minute: 'm',
    minutes: 'm',
    month: 'mo',
    months: 'mo',
    quarter: 'q',
    quarters: 'q',
    second: 's',
    seconds: 's',
    week: 'w',
    weeks: 'w',
    year: 'y',
    years: 'y',
};

/**
 * The units `Intl`'s narrow style abbreviates in the spelled-out wording above; everything else keeps its full noun.
 */
const NARROW_NOUNS: Partial<Record<Intl.RelativeTimeFormatUnit, string>> = {
    month: 'mo.',
    months: 'mo.',
    year: 'yr.',
    years: 'yr.',
};

const fallbackRelativeTime = (
    value: number,
    unit: Intl.RelativeTimeFormatUnit,
    style: RelativeTimeStyle,
): string => {
    /*
     * `numeric: 'auto'` spells these out rather than counting, and narrow shortens only the two units it has an
     * abbreviation for: "last mo." and "this yr.", but still "yesterday" and "this hour". Matching that exactly is what
     * keeps a runtime without the formatter from rendering a different word than every other runtime.
     */
    const noun = (style === 'narrow' ? NARROW_NOUNS[unit] : undefined) ?? unit;
    if (value === 0) return unit === 'second' ? 'now' : `this ${noun}`;
    if (value === -1 && unit === 'day') return 'yesterday';
    if (value === 1 && unit === 'day') return 'tomorrow';
    if (value === -1 && (unit === 'month' || unit === 'year')) return `last ${noun}`;
    if (value === 1 && (unit === 'month' || unit === 'year')) return `next ${noun}`;

    const absoluteValue = Math.abs(value);
    const label =
        style === 'narrow'
            ? `${absoluteValue}${NARROW_UNITS[unit]}`
            : `${absoluteValue} ${unit}${absoluteValue === 1 ? '' : 's'}`;
    return value < 0 ? `${label} ago` : `in ${label}`;
};

/**
 * Uses the native formatter when available and preserves the same English output on runtimes such as Hermes that do not
 * provide `Intl.RelativeTimeFormat`. Construction is lazy so importing `@caxri/utils` remains portable even when
 * callers do not use relative-time formatting.
 */
const createRelativeTimeFormatter = () => {
    let cachedConstructor: RelativeTimeFormatConstructor | undefined;
    const cachedFormatters = new Map<RelativeTimeStyle, Intl.RelativeTimeFormat | undefined>();

    return (value: number, unit: Intl.RelativeTimeFormatUnit, style: RelativeTimeStyle): string => {
        const Constructor = Intl.RelativeTimeFormat as RelativeTimeFormatConstructor | undefined;
        if (Constructor !== cachedConstructor) {
            cachedConstructor = Constructor;
            cachedFormatters.clear();
        }
        if (!cachedFormatters.has(style)) {
            cachedFormatters.set(
                style,
                Constructor ? new Constructor('en', { numeric: 'auto', style }) : undefined,
            );
        }
        return (
            cachedFormatters.get(style)?.format(value, unit) ??
            fallbackRelativeTime(value, unit, style)
        );
    };
};

const formatRelativeTime = createRelativeTimeFormatter();

/**
 * Formats a past or future timestamp relative to now, e.g. "3 minutes ago" or "in 2 days".
 *
 * @param timestamp - Epoch milliseconds of the moment to describe.
 * @param now - Epoch milliseconds to measure from; injectable for deterministic tests.
 * @param style - `long` prose by default; `narrow` ("3m ago") for a dense row that cannot spend the width.
 */
export function relativeTime(
    timestamp: number,
    now: number = Date.now(),
    style: RelativeTimeStyle = 'long',
): string {
    const seconds = Math.round((timestamp - now) / 1_000);
    for (const [unit, size] of RELATIVE_TIME_RANGES) {
        if (Math.abs(seconds) >= size)
            return formatRelativeTime(Math.round(seconds / size), unit, style);
    }
    return formatRelativeTime(seconds, 'second', style);
}
