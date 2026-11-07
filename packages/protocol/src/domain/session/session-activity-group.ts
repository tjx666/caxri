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
 * What a row contributes to its order inside a status group.
 */
export type SessionActivityRowOrder = Pick<
    SessionRecord,
    'attentionResolvedAt' | 'id' | 'lastAttentionKind' | 'sessionActivityAt' | 'turnStartedAt'
>;

/**
 * Tiers inside Needs attention: a question or failure blocks the Agent until the user answers; anything else (a result
 * to read, a merged pull request to close out) waits on nothing.
 */
function attentionTier(row: SessionActivityRowOrder): number {
    return row.lastAttentionKind === 'waiting' || row.lastAttentionKind === 'failed' ? 0 : 1;
}

function byRecency(left: number, right: number, leftId: string, rightId: string): number {
    return right - left || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
}

/**
 * When the row entered its current group, the key every group orders by (newest first). It holds still while the row
 * stays in the group, so a row moves only when it changes group, never on its own:
 *
 * - Needs attention: the Session Activity clock, which last moved when the turn ended, asked, or failed.
 * - Working: when the latest turn started (the user's last message or the Agent starting). Not the activity clock, which
 *   also moves when a turn ends into a background wait and would lift the row over turns started after it.
 * - Idle: the later of the activity clock and the moment the user marked the Session done, so a Session just resolved
 *   lands at the top of Idle without moving its activity clock (that clock also orders the Project tree, and an
 *   acknowledgement is not work progressing).
 */
function groupEnteredAt(group: SessionActivityGroupId, row: SessionActivityRowOrder): number {
    if (group === 'working') return row.turnStartedAt ?? row.sessionActivityAt;
    if (group === 'idle') return Math.max(row.sessionActivityAt, row.attentionResolvedAt ?? 0);
    return row.sessionActivityAt;
}

/**
 * Order inside a status group, shared by every surface that ranks Sessions so the Activity view, the next-attention
 * shortcut, and the phone's capped dashboard agree. Urgency first (only Needs attention has tiers: a blocked Agent
 * above a result), then the newest arrival in the group first (`groupEnteredAt`). Nothing a row's own state changes
 * while it stays in a group (a pull request merging, a turn ending into a background wait) reorders it.
 */
export function compareSessionActivityGroupRows(
    group: SessionActivityGroupId,
    left: SessionActivityRowOrder,
    right: SessionActivityRowOrder,
): number {
    if (group === 'attention') {
        const tier = attentionTier(left) - attentionTier(right);
        if (tier !== 0) return tier;
    }
    return byRecency(groupEnteredAt(group, left), groupEnteredAt(group, right), left.id, right.id);
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
