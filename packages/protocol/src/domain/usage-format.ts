/**
 * Compact usage figures shared by every surface that shows Agent usage (the Usage page, and any future status line or
 * CLI readout), so the same number never renders two ways.
 */
import { formatCompactCount } from './line-count-format.js';

/**
 * Estimated cost in US dollars: cents below $1,000, whole dollars below $100k, then thousands.
 */
export function formatUsd(value: number): string {
    if (value <= 0) return '$0';
    if (value < 0.005) return '<$0.01';
    if (value < 999.995) return `$${value.toFixed(2)}`;
    if (value < 99_999.5) return `$${groupThousands(Math.round(value))}`;
    return `$${groupThousands(Math.round(value / 1_000))}k`;
}

/**
 * `12,345`. Hand-rolled like {@link formatCompactCount}: Hermes on Android does not implement locale-aware grouping.
 */
function groupThousands(value: number): string {
    return String(value).replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Token count with a `k`/`M`/`B` suffix and at most one decimal (`1.2M`, `340k`).
 */
export function formatTokens(value: number): string {
    return formatCompactCount(Math.round(value), ['k', 'M', 'B']);
}

/**
 * Active time rounded to minutes (`45m`, `3h 20m`, `120h`).
 */
export function formatDuration(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) return ms > 0 ? '<1m' : '0m';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 100) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
    return `${groupThousands(hours)}h`;
}

/**
 * A 0 to 1 ratio as a percentage with one decimal below 10%.
 */
export function formatPercent(ratio: number): string {
    if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
    if (ratio < 0.001) return '<0.1%';
    return `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
}

const DAY_MS = 86_400_000;

/**
 * Calendar arithmetic on the `YYYY-MM-DD` local dates usage reports use. Anchored at UTC midnight, so adding days never
 * crosses a daylight-saving boundary whatever zone the date was computed in.
 */
export function shiftLocalDate(date: string, days: number): string {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Day of the week of a local date, 0 being Sunday.
 */
export function localDateWeekday(date: string): number {
    return new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
}
