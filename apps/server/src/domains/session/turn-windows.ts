import { rememberBounded } from '@caxri/utils';

import type { SessionActivityTransition } from '../agents';

const MAX_TRACKED_SESSIONS = 256;
const MAX_WINDOWS_PER_SESSION = 32;

/**
 * Clock difference tolerated between GitHub's timestamp and this machine's, so a merge the Agent made in its last
 * second of a turn is still attributed to it.
 */
export const TURN_WINDOW_SKEW_MS = 5000;

interface SessionWindows {
    closed: Array<{ end: number; start: number }>;
    openedAt?: number;
}

/**
 * Remembers when each Session's Agent was working, from the durable activity transitions Server Core already hears.
 * Only this process lifetime is covered, which is enough for its one consumer: a pull request is compared against
 * windows only after Caxri itself watched it open.
 */
export class SessionTurnWindows {
    private readonly sessions = new Map<string, SessionWindows>();

    constructor(private readonly now: () => number = Date.now) {}

    observe({ from, sessionId, to }: SessionActivityTransition): void {
        const at = this.now();
        const windows = this.sessions.get(sessionId) ?? { closed: [] };
        if (to === 'running' && windows.openedAt === undefined) windows.openedAt = at;
        else if (to !== 'running' && from === 'running' && windows.openedAt !== undefined) {
            windows.closed.push({ end: at, start: windows.openedAt });
            if (windows.closed.length > MAX_WINDOWS_PER_SESSION) windows.closed.shift();
            windows.openedAt = undefined;
        }
        rememberBounded(this.sessions, sessionId, windows, MAX_TRACKED_SESSIONS);
    }

    /**
     * Whether `at` (epoch milliseconds) lies inside a finished turn or the one still running.
     */
    contains(sessionId: string, at: number): boolean {
        const windows = this.sessions.get(sessionId);
        if (!windows) return false;
        if (windows.openedAt !== undefined && at >= windows.openedAt - TURN_WINDOW_SKEW_MS)
            return true;
        return windows.closed.some(
            (window) =>
                at >= window.start - TURN_WINDOW_SKEW_MS && at <= window.end + TURN_WINDOW_SKEW_MS,
        );
    }
}
