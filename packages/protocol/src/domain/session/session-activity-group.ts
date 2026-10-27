import type { SessionRecord } from '../domain.js';

/**
 * The status groups Session lists sort into, shared by Desktop's Activity view and the phone's home list so a Session
 * sits under the same heading on both. Attention first, then live work, then everything that is merely history.
 *
 * `attention` deliberately outranks `working`: Caxri's unread flag means "something happened that you have not looked
 * at", which is a property of the user's queue rather than of the Agent, so it belongs above any turn still in
 * progress, including the Session's own, since a Session can be both unread and running. herdr and Kero rank their
 * rollups the same way; Orca and T3 Code put running work first because their lists describe live work rather than a
 * to-do queue.
 */
export const SESSION_ACTIVITY_GROUP_ORDER = [
    'attention',
    'working',
    'waiting',
    'failed',
    'finished',
    'idle',
] as const;

export type SessionActivityGroupId = (typeof SESSION_ACTIVITY_GROUP_ORDER)[number];

/**
 * Status groups that keep a pinned Session even though the Pinned group already lists it. These are the rows the queue
 * exists for: the attention badge and `session.focusNextAttention` walk them, and a Session that is running, waiting,
 * or failed is news the user should see in its state group. A pinned Session that is merely finished or idle is listed
 * only under Pinned, where repeating it would add a second copy and no information.
 */
export const PINNED_DUPLICATE_SESSION_ACTIVITY_GROUPS: ReadonlySet<SessionActivityGroupId> =
    new Set(['attention', 'working', 'waiting', 'failed']);

/**
 * How long a finished, already-read Session stays under "Recently finished".
 *
 * Both ends of this window are deliberate. Dropping a Session the moment it is read would mean a turn that finished
 * while the user was looking at it never appears in the group at all, so the list could not answer "what just
 * completed?". Keeping it forever would turn the group into a second copy of the Session tree. T3 Code settled on the
 * same 15 minutes for its own aggregate feed.
 */
export const SESSION_FINISHED_RETENTION_MS = 15 * 60 * 1_000;

/**
 * Whether a finished Session is still recent enough to list as finished.
 *
 * Measured from `sessionActivityAt`, the Session's own work clock, rather than from when the user read it, so the
 * window describes how long ago the work finished and does not restart because the row was looked at.
 */
export function isWithinSessionFinishedRetention(
    session: Pick<SessionRecord, 'sessionActivityAt'>,
    now: number,
    retentionMs = SESSION_FINISHED_RETENTION_MS,
): boolean {
    return now - session.sessionActivityAt < retentionMs;
}

/**
 * The group a Session belongs to, or `undefined` for a finished Session past the retention window, which each surface
 * places itself: Desktop's Activity view drops it (the Project tree still lists it), and the phone, whose home list is
 * its only Session list, files it under Idle.
 *
 * `isRunning` and `isDetached` come from the caller's status projection: Desktop folds compaction into running and
 * reads the Terminal's process state, which the phone mirrors from the fields it receives.
 */
export function sessionActivityGroup(
    session: Pick<SessionRecord, 'hasUnread' | 'agentActivityState' | 'sessionActivityAt'> & {
        isDetached: boolean;
        isRunning: boolean;
    },
    now: number,
): SessionActivityGroupId | undefined {
    if (session.hasUnread) return 'attention';
    /**
     * Failure survives the hand-over. Detaching stops the Terminal so another client can resume it; it does not resolve
     * anything, and nothing else will ever clear a failed Session, so a detached failure stays in `failed` rather than
     * quietly joining `idle` below.
     */
    if (session.agentActivityState === 'failed') return 'failed';
    if (session.isRunning) return 'working';
    /**
     * Everything below reads `agentActivityState`, which a detached Agent keeps frozen at whatever the last probe
     * recorded. Without this guard a Session detached mid-turn would keep sitting under "Waiting" (or age out of
     * "Recently finished" and vanish) while its own row reads "Detached". It is not waiting on anybody: it was handed
     * to another client on purpose.
     */
    if (session.isDetached) return 'idle';
    if (session.agentActivityState === 'waiting') return 'waiting';
    if (session.agentActivityState === 'completed')
        return isWithinSessionFinishedRetention(session, now) ? 'finished' : undefined;
    // `idle` and `unknown` land here: neither is asking the user for anything.
    return 'idle';
}

/**
 * Order inside a status group: the most recent Session work first, so a new message or state change moves a row to the
 * top of its group at once.
 */
export function compareSessionActivityGroupRows(
    left: Pick<SessionRecord, 'id' | 'sessionActivityAt'>,
    right: Pick<SessionRecord, 'id' | 'sessionActivityAt'>,
): number {
    return (
        right.sessionActivityAt - left.sessionActivityAt ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
}
