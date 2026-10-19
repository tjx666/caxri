/**
 * Compact usage figures shared by every surface that shows Agent usage (the Usage page, and any future status line or
 * CLI readout), so the same number never renders two ways.
 */
import { formatCompactCount } from './line-count-format.js';
import type { UsageLimit } from './usage-contract.js';

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

type UsageLimitWindow = UsageLimit['windows'][number];

/**
 * Compact rate-limit window name for a status readout: `5h`, `7d`, `90m`.
 */
export function shortLimitWindowName(minutes: number): string {
    if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
}

/**
 * Rate-limit windows that have not reset since the provider reported them, shortest first. A window whose reset time
 * has passed reports usage that no longer applies, so it is dropped rather than shown stale.
 */
export function currentLimitWindows(
    limit: UsageLimit | null | undefined,
    now: number,
): UsageLimitWindow[] {
    if (!limit) return [];
    // `filter` already copies, and the phone's Hermes runtime lacks ES2023 `toSorted`, so the copy sorts in place.
    return (
        limit.windows
            .filter((window) => window.resetsAt === undefined || window.resetsAt > now)
            // eslint-disable-next-line unicorn/no-array-sort -- Sorts the fresh copy `filter` returned; see above.
            .sort((a, b) => a.windowMinutes - b.windowMinutes)
    );
}

/**
 * Share of a rate-limit window still available, whole percent. Every surface states what is left rather than what is
 * used, the way the Agent CLIs' own `/status` reads, since what is left is the figure a user plans the next turn by.
 */
export function remainingLimitPercent(usedPercent: number): number {
    return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)));
}

/**
 * How far below an even pace a window's remaining share must fall before {@link limitPaceShortfall} reports it, in
 * percentage points. Early in a week a single long task already runs ahead of `1/7` a day; the margin keeps the
 * reminder for a day that really overspent.
 */
export const LIMIT_PACE_MARGIN_PERCENT = 5;

/**
 * A multi-day plan window (Claude Code's and Codex's weekly limit) whose remaining share is below what an even pace
 * would leave: with 40% left and 5 of 7 days to go, an even pace leaves about 71%, so the rest of the week cannot be
 * used at the rate the week has been. Shorter windows reset within the working day and never need pacing. Reports the
 * most behind window, or `undefined` while every window is on pace or no window states its reset time.
 */
export function limitPaceShortfall(
    limit: UsageLimit | null | undefined,
    now: number,
): { window: UsageLimitWindow & { resetsAt: number }; evenPacePercent: number } | undefined {
    let worst: ReturnType<typeof limitPaceShortfall>;
    let worstGap = LIMIT_PACE_MARGIN_PERCENT;
    for (const window of currentLimitWindows(limit, now)) {
        if (window.windowMinutes < 1_440 || window.resetsAt === undefined) continue;
        const remainingTime = (window.resetsAt - now) / (window.windowMinutes * 60_000);
        const evenPacePercent = Math.round(Math.min(1, Math.max(0, remainingTime)) * 100);
        const gap = evenPacePercent - remainingLimitPercent(window.usedPercent);
        if (gap < worstGap) continue;
        worstGap = gap;
        worst = { window: { ...window, resetsAt: window.resetsAt }, evenPacePercent };
    }
    return worst;
}
