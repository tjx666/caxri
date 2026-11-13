import { z } from 'zod';

/**
 * Sessions this phone remembers opening, per pairing. Only the newest one other than the open Session is offered as
 * "Previous Session"; the rest keep it findable after that one is archived.
 */
export const RECENT_SESSIONS_MAX_ENTRIES = 10;

/**
 * Session IDs, most recently opened first.
 */
export const recentSessionsSchema = z.array(z.string().min(1)).max(RECENT_SESSIONS_MAX_ENTRIES);

export type RecentSessions = z.infer<typeof recentSessionsSchema>;

/**
 * Moves `sessionId` to the front. Returns `recent` itself when it is already there, so reopening the same Session does
 * not change state or rewrite the saved copy.
 */
export const rememberRecentSession = (recent: RecentSessions, sessionId: string): RecentSessions =>
    recent[0] === sessionId
        ? recent
        : [sessionId, ...recent.filter((id) => id !== sessionId)].slice(
              0,
              RECENT_SESSIONS_MAX_ENTRIES,
          );

/**
 * Restores the saved list behind what this launch already opened: a Session opened before the read finished stays
 * newest.
 */
export const mergeSavedRecentSessions = (
    recent: RecentSessions,
    saved: RecentSessions,
): RecentSessions => [...new Set([...recent, ...saved])].slice(0, RECENT_SESSIONS_MAX_ENTRIES);

/**
 * The Session "Previous Session" returns to: the most recently opened one other than `currentSessionId` that is still
 * listed. A Session missing from the list (archived, deleted, or past the list's limit) is skipped rather than offered
 * as a destination that would open on an error.
 */
export const previousRecentSession = <Session extends { id: string }>(
    recent: RecentSessions,
    currentSessionId: string,
    listed: readonly Session[],
): Session | null => {
    const byId = new Map(listed.map((session) => [session.id, session]));
    for (const id of recent) {
        if (id === currentSessionId) continue;
        const session = byId.get(id);
        if (session) return session;
    }
    return null;
};
