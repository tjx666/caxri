import { CLAUDE_WINDOW_MINUTES } from '@caxri/protocol';

const MINUTE = 60_000;
const DAY_MINUTES = 1_440;
export const WINDOW_MS = CLAUDE_WINDOW_MINUTES * MINUTE;

/**
 * How long after a planned time a check still counts as on time. A later check served a time the Mac slept through or
 * Caxri was closed for, and is recorded as such.
 */
const ON_TIME_GRACE_MS = 10 * MINUTE;

/**
 * How long after a reported reset the keeper looks again, so Claude's own clock has passed it.
 */
const RESET_BUFFER_MS = MINUTE;

/**
 * The epoch time of a local wall-clock minute on a local calendar day. `Date` resolves a time skipped by a DST change
 * forward and a repeated one to its first occurrence, which is what an alarm clock does, and it follows the process
 * time zone, so a zone change takes effect at the next computation.
 */
function localTime(day: Date, dayOffset: number, minuteOfDay: number): number {
    return new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate() + dayOffset,
        Math.floor(minuteOfDay / 60),
        minuteOfDay % 60,
    ).getTime();
}

/**
 * Minute of the day the morning anchor falls on: `First workday reset at` minus five hours, wrapping past midnight.
 */
export function anchorMinuteOfDay(firstWorkdayResetMinutes: number): number {
    return (firstWorkdayResetMinutes - CLAUDE_WINDOW_MINUTES + DAY_MINUTES) % DAY_MINUTES;
}

function anchorsAround(now: number, firstWorkdayResetMinutes: number): number[] {
    const day = new Date(now);
    const minute = anchorMinuteOfDay(firstWorkdayResetMinutes);
    return [-2, -1, 0, 1, 2].map((offset) => localTime(day, offset, minute));
}

/**
 * The latest morning anchor at or before `now`.
 */
export function previousAnchor(now: number, firstWorkdayResetMinutes: number): number {
    return anchorsAround(now, firstWorkdayResetMinutes).findLast((anchor) => anchor <= now)!;
}

/**
 * The first morning anchor after `now`.
 */
export function nextAnchor(now: number, firstWorkdayResetMinutes: number): number {
    return anchorsAround(now, firstWorkdayResetMinutes).find((anchor) => anchor > now)!;
}

/**
 * Whether a window started at `startAt` ends by the next morning anchor. A renewal that would run past it is skipped,
 * so the window is idle at the anchor and the day realigns: 24 hours is not a multiple of five.
 */
export function isEndingBeforeNextAnchor(
    startAt: number,
    firstWorkdayResetMinutes: number,
): boolean {
    return startAt + WINDOW_MS <= nextAnchor(startAt, firstWorkdayResetMinutes);
}

/**
 * Local times the background job wakes the keeper each day: the anchor, then each renewal of the anchored chain whose
 * window still ends by the next anchor, a minute after the reset. With the default 10:00 that is 05:00, 10:01, 15:01,
 * and 20:01. A chain a real request shifted is followed by the in-process timer while Server Core runs; these times
 * only guarantee the anchored day while Caxri is closed.
 */
export function dailyWakeTimes(
    firstWorkdayResetMinutes: number,
): Array<{ hour: number; minute: number }> {
    const anchor = anchorMinuteOfDay(firstWorkdayResetMinutes);
    const offsets = [0];
    for (
        let renewal = CLAUDE_WINDOW_MINUTES;
        renewal + CLAUDE_WINDOW_MINUTES <= DAY_MINUTES;
        renewal += CLAUDE_WINDOW_MINUTES
    )
        offsets.push(renewal + RESET_BUFFER_MS / MINUTE);
    return offsets.map((offset) => {
        const minuteOfDay = (anchor + offset) % DAY_MINUTES;
        return { hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 };
    });
}

export interface KeeperMemory {
    /**
     * The planned time (an anchor or a reset) of the newest window the keeper already handled. Every candidate at or
     * before it is spent, which makes a check idempotent across restarts, wakes, and repeated background runs.
     */
    processedThroughAt?: number;
    /**
     * The newest 5-hour reset Claude Code reported; its passing is when the next renewal is due.
     */
    observedResetAt?: number;
}

export interface KeeperReading {
    /**
     * When the active window resets; absent or past for an idle window.
     */
    windowResetsAt?: number;
    isWeeklyLimitReached: boolean;
}

interface DueWindow {
    /**
     * The anchor or reset this window is planned for; it becomes `processedThroughAt` once handled.
     */
    plannedAt: number;
    reason: 'anchor' | 'renewal';
    /**
     * True when the check runs after the grace period, because the Mac slept or Caxri was closed at `plannedAt`.
     */
    isMissed: boolean;
}

export type KeeperDecision =
    | {
          kind: 'active';
          resetsAt: number;
          /**
           * Whether the keeper renews this window when it resets.
           */
          renews: boolean;
          /**
           * A due window a real request already started; it is spent without a request.
           */
          naturalFor?: DueWindow;
      }
    | { kind: 'trigger'; due: DueWindow }
    | { kind: 'skipRenewal'; due: DueWindow }
    | { kind: 'weeklyLimit'; due: DueWindow }
    | { kind: 'idle' };

/**
 * The window due at `now`, if any. An anchor is due until its own window would have ended; a renewal is due once the
 * observed window reset, as long as it is not older than the latest anchor. When both are due (a skipped night renewal
 * and the morning anchor after a wake), the later one wins and spends both.
 */
function dueWindow(
    now: number,
    firstWorkdayResetMinutes: number,
    memory: KeeperMemory,
): DueWindow | undefined {
    const processedThroughAt = memory.processedThroughAt ?? -Infinity;
    const candidates: Array<Omit<DueWindow, 'isMissed'>> = [];
    const anchor = previousAnchor(now, firstWorkdayResetMinutes);
    if (anchor > processedThroughAt && now < anchor + WINDOW_MS)
        candidates.push({ plannedAt: anchor, reason: 'anchor' });
    // A reset older than the latest anchor belongs to a chain a new day already replaced (Caxri was closed for days).
    const reset = memory.observedResetAt;
    if (reset !== undefined && reset <= now && reset > processedThroughAt && reset >= anchor)
        candidates.push({ plannedAt: reset, reason: 'renewal' });
    if (candidates.length === 0) return undefined;
    const [due] = candidates.toSorted((a, b) => b.plannedAt - a.plannedAt);
    return { ...due, isMissed: now - due.plannedAt > ON_TIME_GRACE_MS };
}

/**
 * What the keeper does at `now` for an enabled account, from a fresh reading. Pure: the caller persists the spent
 * window (`processedThroughAt`) before it sends anything, so a crash mid-request never sends twice.
 */
export function decide(
    now: number,
    firstWorkdayResetMinutes: number,
    reading: KeeperReading,
    memory: KeeperMemory,
): KeeperDecision {
    const due = dueWindow(now, firstWorkdayResetMinutes, memory);
    const resetsAt = reading.windowResetsAt;
    if (resetsAt !== undefined && resetsAt > now)
        return {
            kind: 'active',
            resetsAt,
            renews: isEndingBeforeNextAnchor(resetsAt, firstWorkdayResetMinutes),
            ...(due && { naturalFor: due }),
        };
    if (!due) return { kind: 'idle' };
    if (due.reason === 'renewal' && !isEndingBeforeNextAnchor(now, firstWorkdayResetMinutes))
        return { kind: 'skipRenewal', due };
    if (reading.isWeeklyLimitReached) return { kind: 'weeklyLimit', due };
    return { kind: 'trigger', due };
}

/**
 * When the keeper should look next: a minute after the active window resets when it renews it (or to notice it ended),
 * otherwise the next anchor, and never later than `maxDelayMs` from now so a window a real request started is noticed.
 */
export function nextCheckAt(
    now: number,
    firstWorkdayResetMinutes: number,
    windowResetsAt: number | undefined,
    maxDelayMs: number,
): number {
    const candidates = [nextAnchor(now, firstWorkdayResetMinutes), now + maxDelayMs];
    if (windowResetsAt !== undefined && windowResetsAt > now)
        candidates.push(windowResetsAt + RESET_BUFFER_MS);
    return Math.min(...candidates);
}
