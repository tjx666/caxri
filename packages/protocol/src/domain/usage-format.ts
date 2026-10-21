/**
 * Compact usage figures shared by every surface that shows Agent usage (the Usage page, and any future status line or
 * CLI readout), so the same number never renders two ways.
 */
import { compactCountParts, formatCompactCount } from './line-count-format.js';
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

const TOKEN_SUFFIXES = ['k', 'M', 'B'] as const;

/**
 * Token count with a `k`/`M`/`B` suffix and at most one decimal (`1.2M`, `340k`).
 */
export function formatTokens(value: number): string {
    return formatCompactCount(Math.round(value), TOKEN_SUFFIXES);
}

/**
 * {@link formatTokens} split into the scaled figure and its suffix, for a surface that animates the figure.
 */
export function tokenCountParts(value: number): { value: number; suffix: string } {
    return compactCountParts(Math.round(value), TOKEN_SUFFIXES);
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
 * The share of a window that must have elapsed before {@link limitPaceShortfall} projects anything, as a fraction.
 * Extrapolating from the first hours of a 7-day window mistakes one long task (14% used after 12 hours) for a trend, so
 * the reminder waits until a tenth of the window, about 17 hours of a week, has passed.
 */
export const LIMIT_PACE_MIN_ELAPSED = 0.1;

/**
 * A multi-day plan window (Claude Code's and Codex's weekly limit) that, at the rate it has been used so far, reaches
 * 100% before it resets: `usedPercent / elapsedFraction > 100`. A window with 60% used and 5 of 7 days left has spent
 * 60% in 2 days and projects 210%, so it runs out; one with 14% used after 12 hours is merely in a busy first stretch.
 * Windows are ignored until {@link LIMIT_PACE_MIN_ELAPSED} of them has elapsed. `evenPacePercent` is the share an even
 * pace would still have left now. Shorter windows reset within the working day and never need pacing. Reports the
 * window projected to overshoot most, or `undefined` while every window is on course or no window states its reset
 * time.
 */
export function limitPaceShortfall(
    limit: UsageLimit | null | undefined,
    now: number,
): { window: UsageLimitWindow & { resetsAt: number }; evenPacePercent: number } | undefined {
    let worst: ReturnType<typeof limitPaceShortfall>;
    let worstProjection = 100;
    for (const window of currentLimitWindows(limit, now)) {
        if (window.windowMinutes < 1_440 || window.resetsAt === undefined) continue;
        const remainingTime = Math.min(
            1,
            Math.max(0, (window.resetsAt - now) / (window.windowMinutes * 60_000)),
        );
        const elapsed = 1 - remainingTime;
        if (elapsed < LIMIT_PACE_MIN_ELAPSED) continue;
        const projectedPercent = window.usedPercent / elapsed;
        if (projectedPercent <= worstProjection) continue;
        worstProjection = projectedPercent;
        worst = {
            window: { ...window, resetsAt: window.resetsAt },
            evenPacePercent: Math.round(remainingTime * 100),
        };
    }
    return worst;
}
