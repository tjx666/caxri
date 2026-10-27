import { localDateWeekday, shiftLocalDate } from '@caxri/protocol';

/**
 * A custom report range: the first and last local day (`YYYY-MM-DD`), both inclusive, `start <= end`.
 */
export interface UsageCustomRange {
    start: string;
    end: string;
}

/**
 * The calendar's in-progress pick: a lone `start` waits for the second click, which completes the range.
 */
export interface UsageRangeDraft {
    start: string;
    end: string | undefined;
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A stored custom range, or `undefined` when it is missing, malformed, or reversed.
 */
export function parseUsageCustomRange(stored: unknown): UsageCustomRange | undefined {
    if (typeof stored !== 'object' || stored === null) return undefined;
    const { start, end } = stored as Record<string, unknown>;
    if (typeof start !== 'string' || typeof end !== 'string') return undefined;
    if (!LOCAL_DATE.test(start) || !LOCAL_DATE.test(end) || start > end) return undefined;
    return { start, end };
}

/**
 * The local calendar day of an epoch-millisecond timestamp, `YYYY-MM-DD`.
 */
export function localDateOf(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * The month `delta` months from `month` (`YYYY-MM`).
 */
export function shiftMonth(month: string, delta: number): string {
    const [year, monthNumber] = month.split('-').map(Number);
    const index = year * 12 + monthNumber - 1 + delta;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * One month as calendar weeks, Sunday first like the Activity heatmap; days outside the month are `undefined`.
 */
export function monthWeeks(month: string): Array<Array<string | undefined>> {
    const first = `${month}-01`;
    const nextFirst = `${shiftMonth(month, 1)}-01`;
    const weeks: Array<Array<string | undefined>> = [];
    let week = Array.from<string | undefined>({ length: localDateWeekday(first) });
    for (let day = first; day < nextFirst; day = shiftLocalDate(day, 1)) {
        week.push(day);
        if (week.length === 7) {
            weeks.push(week);
            week = [];
        }
    }
    if (week.length > 0)
        weeks.push([...week, ...Array.from<string | undefined>({ length: 7 - week.length })]);
    return weeks;
}

/**
 * A calendar click: the first click (or one after a completed range) starts a new range, the second completes it in
 * date order, so picking the end before the start still works.
 */
export function pickRangeDay(draft: UsageRangeDraft | undefined, day: string): UsageRangeDraft {
    if (!draft || draft.end !== undefined) return { start: day, end: undefined };
    return day < draft.start ? { start: day, end: draft.start } : { start: draft.start, end: day };
}

/**
 * The days a draft highlights: a completed range, or while waiting for the second click, the span from the start to the
 * hovered day.
 */
export function draftSpan(
    draft: UsageRangeDraft | undefined,
    hovered: string | undefined,
): UsageCustomRange | undefined {
    if (!draft) return undefined;
    const end = draft.end ?? hovered ?? draft.start;
    return end < draft.start ? { start: end, end: draft.start } : { start: draft.start, end };
}
