/**
 * Preset time windows offered by the Archived Sessions dialog (archive time) and Session search (last activity).
 * Presets instead of a date picker: the common visit is "something from this week", and an exact window stays available
 * in Session search through the `before:` and `after:` operators.
 */
export const sessionTimeRanges = ['all', 'today', 'last7Days', 'last30Days', 'last90Days'] as const;
export type SessionTimeRange = (typeof sessionTimeRanges)[number];

/**
 * Calendar days each window covers, today included.
 */
const RANGE_DAYS = {
    today: 1,
    last7Days: 7,
    last30Days: 30,
    last90Days: 90,
} as const satisfies Record<Exclude<SessionTimeRange, 'all'>, number>;

export const sessionTimeRangeLabelKeys = {
    all: 'session.timeRange.all',
    today: 'session.timeRange.today',
    last7Days: 'session.timeRange.last7Days',
    last30Days: 'session.timeRange.last30Days',
    last90Days: 'session.timeRange.last90Days',
} as const satisfies Record<SessionTimeRange, string>;

/**
 * Local midnight that opens the window, or undefined for `all`. Windows are local calendar days, matching how the
 * Server reads an `after:` date, so "Last 7 Days" means today and the six days before it, not the last 168 hours. The
 * value only changes at midnight, so it is stable enough to key a query on.
 */
export function sessionTimeRangeStart(range: SessionTimeRange, now: number): number | undefined {
    if (range === 'all') return undefined;
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (RANGE_DAYS[range] - 1));
    return start.getTime();
}

/**
 * The next preset in the dropdown's order, wrapping back to `all`; the Session search shortcut steps through it.
 */
export function nextSessionTimeRange(range: SessionTimeRange): SessionTimeRange {
    return sessionTimeRanges[(sessionTimeRanges.indexOf(range) + 1) % sessionTimeRanges.length];
}
