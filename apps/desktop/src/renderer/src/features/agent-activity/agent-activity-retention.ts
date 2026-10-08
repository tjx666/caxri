import type { SessionRecord } from '@caxri/protocol';

/**
 * How long a finished, already-read Session stays listed under "Recently finished" before the Activity view drops it.
 *
 * Both ends of this window are deliberate. Dropping a Session the moment it is read would mean a turn that finished
 * while the user was looking at it never appears in the list at all, so the list could not answer "what just
 * completed?". Keeping it forever would turn the Activity view into a second copy of the Session tree, which is the one
 * thing it exists not to be. T3 Code settled on the same 15 minutes for its own aggregate feed.
 */
export const AGENT_ACTIVITY_FINISHED_RETENTION_MS = 15 * 60 * 1_000;

/**
 * Whether a finished Session is still recent enough to list.
 *
 * Measured from `lastSessionActivityAt`, the Session's own work clock, rather than from when the user read it, so the
 * window describes how long ago the work finished and does not restart because the row was looked at.
 */
export function isWithinFinishedRetention(
    session: Pick<SessionRecord, 'lastSessionActivityAt'>,
    now: number,
    retentionMs = AGENT_ACTIVITY_FINISHED_RETENTION_MS,
): boolean {
    return now - session.lastSessionActivityAt < retentionMs;
}
