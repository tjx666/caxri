const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const RELATIVE_TIME_RANGES: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
];

/**
 * Formats a past or future timestamp relative to now, e.g. "3 minutes ago" or "in 2 days".
 *
 * @param timestamp - Epoch milliseconds of the moment to describe.
 * @param now - Epoch milliseconds to measure from; injectable for deterministic tests.
 */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
    const seconds = Math.round((timestamp - now) / 1_000);
    for (const [unit, size] of RELATIVE_TIME_RANGES) {
        if (Math.abs(seconds) >= size)
            return RELATIVE_TIME_FORMATTER.format(Math.round(seconds / size), unit);
    }
    return RELATIVE_TIME_FORMATTER.format(seconds, 'second');
}
