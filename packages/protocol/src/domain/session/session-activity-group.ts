import type { SessionRecord, TerminalRecord } from '../domain.js';

/**
 * The status groups Session lists sort into, shared by Desktop's Activity view and the phone's home list so a Session
 * sits under the same heading on both: what still needs the user, then live work, then everything else.
 *
 * `attention` ("Needs attention") holds Pending Attention: an Agent turn ended (finished, asked, or failed) and the
 * user has not resolved it yet. Reading is not resolving. The user often opens a finished Session, has not decided the
 * next step, and switches away to handle another one; when reading moved the row into a time-limited "Recently
 * finished" group it left the queue exactly while it was still the user's move. Only marking it done, a new turn, or
 * the question being answered elsewhere resolves it, the way GitHub notifications and Linear's Inbox separate "read"
 * from "Done". Orca's smart order keeps the same three tiers (needs you, working, idle).
 *
 * `attention` outranks `working` because a running Agent asks nothing of the user until it stops.
 */
export const SESSION_ACTIVITY_GROUP_ORDER = ['attention', 'working', 'idle'] as const;

export type SessionActivityGroupId = (typeof SESSION_ACTIVITY_GROUP_ORDER)[number];

/**
 * Status groups that keep a pinned Session even though the Pinned group already lists it. These are the rows the queue
 * exists for: the attention badge and `session.focusNextAttention` walk them, and a running Session is news the user
 * should see in its state group. A pinned idle Session is listed only under Pinned, where repeating it would add a
 * second copy and no information.
 */
export const PINNED_DUPLICATE_SESSION_ACTIVITY_GROUPS: ReadonlySet<SessionActivityGroupId> =
    new Set(['attention', 'working']);

/**
 * Session list groups that can grow without bound, so Desktop's Activity view and the phone's home list both show their
 * newest few and a `Show N more` row (`sessionListWindow`), the way the Project tree windows each Project. The status
 * groups that ask for the user (attention, working) always list everything, since a hidden row there is work nobody
 * sees.
 */
export const WINDOWED_SESSION_LIST_GROUPS: ReadonlySet<'pinned' | SessionActivityGroupId> = new Set(
    ['pinned', 'idle'],
);

/**
 * Whether the Agent is doing work right now: a running turn, or a compaction, which has no turn of its own. Unlike a
 * list status slot it is never masked by unread attention. Desktop, the Server's mobile dashboard, and the phone all
 * read it here, so a compacting Session sits under Working on every surface.
 */
export function isSessionAgentRunning(
    session: Pick<SessionRecord, 'agentActivityState'>,
    terminal: Pick<TerminalRecord, 'agentOperation'> | undefined,
): boolean {
    return terminal?.agentOperation === 'compacting' || session.agentActivityState === 'running';
}

/**
 * The group a Session belongs to.
 *
 * `isRunning` comes from {@link isSessionAgentRunning}; `isDetached` and `isUsageWaiting` from the caller's Primary
 * Agent Terminal fields. They must describe the Agent itself, not a status that unread attention already masks.
 */
export function sessionActivityGroup(
    session: Pick<SessionRecord, 'hasPendingAttention'> & {
        /**
         * A Terminal handed to another client on purpose: its frozen activity state describes nobody's work here, but a
         * pending result it left behind still waits for the user.
         */
        isDetached: boolean;
        isRunning: boolean;
        /**
         * A Chat waiting for a plan limit to reset continues on its own, so it asks nothing of the user: it is idle,
         * even when the limit left a pending failure behind. Absent where the caller does not know of waits.
         */
        isUsageWaiting?: boolean;
    },
): SessionActivityGroupId {
    if (session.isUsageWaiting) return 'idle';
    if (session.isRunning && !session.isDetached) return 'working';
    if (session.hasPendingAttention) return 'attention';
    return 'idle';
}

/**
 * What a row contributes to its order inside a status group. The two optional facts come from caches the caller owns
 * (the pull request snapshot and the live Agent's background-work variant); a caller without them orders by recency.
 */
export interface SessionActivityRowOrder extends Pick<
    SessionRecord,
    'attentionResolvedAt' | 'id' | 'lastAttentionKind' | 'sessionActivityAt'
> {
    /**
     * The turn ended but background shells, subagents, or monitors it started still run. Usually the code is written
     * and the Agent watches CI or a test run, so it is the next one likely to need the user.
     */
    isBackgroundWait?: boolean;
    isPullRequestMerged?: boolean;
}

/**
 * Tiers inside Needs attention: a question or failure blocks the Agent until the user answers; a merged pull request is
 * a finished task waiting to be closed out; anything else is a result to read.
 */
function attentionTier(row: SessionActivityRowOrder): number {
    if (row.lastAttentionKind === 'waiting' || row.lastAttentionKind === 'failed') return 0;
    if (row.isPullRequestMerged) return 1;
    return 2;
}

function byRecency(left: number, right: number, leftId: string, rightId: string): number {
    return right - left || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
}

/**
 * Order inside a status group, shared by every surface that ranks Sessions so the Activity view, the next-attention
 * shortcut, and the phone's capped dashboard agree. Ties fall back to the most recent Session work, so a new event
 * moves a row to the top of its tier at once.
 *
 * Idle ranks by the later of the work clock and the moment the user marked the Session done, so a Session just resolved
 * lands at the top of Idle without its `sessionActivityAt` moving (that clock also orders the Project tree, and an
 * acknowledgement is not work progressing).
 */
export function compareSessionActivityGroupRows(
    group: SessionActivityGroupId,
    left: SessionActivityRowOrder,
    right: SessionActivityRowOrder,
): number {
    if (group === 'attention') {
        const tier = attentionTier(left) - attentionTier(right);
        if (tier !== 0) return tier;
    } else if (group === 'working') {
        const background =
            Number(right.isBackgroundWait ?? false) - Number(left.isBackgroundWait ?? false);
        if (background !== 0) return background;
    } else
        return byRecency(
            Math.max(left.sessionActivityAt, left.attentionResolvedAt ?? 0),
            Math.max(right.sessionActivityAt, right.attentionResolvedAt ?? 0),
            left.id,
            right.id,
        );
    return byRecency(left.sessionActivityAt, right.sessionActivityAt, left.id, right.id);
}

/**
 * The shape an unread attention glyph takes, so "the Agent is blocked on you" and "there is a result to read" differ
 * without relying on color. A failed turn or an unknown cause has nothing to answer, so it keeps the result's dot.
 * Shared by the Desktop sidebar and the phone's Session row.
 */
export type SessionAttentionVariant = 'result' | 'waiting';

export function sessionAttentionVariant(
    lastAttentionKind: string | undefined,
): SessionAttentionVariant {
    return lastAttentionKind === 'waiting' ? 'waiting' : 'result';
}
