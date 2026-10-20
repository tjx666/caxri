import type { AgentChatActivity, AgentToolKind, AppSettings } from '@caxri/protocol';

/**
 * What Buddy acts out. Each mood has its own face and prop so it reads at 16px: `think` looks up with thought bubbles,
 * `read` scans a line, `search` wears a monocle, `run` jogs and sweats, `compact` is squashed with `> <` eyes, `wait`
 * dozes, and `tired` yawns after one tool has run a long time.
 */
export type BuddyMood = 'compact' | 'read' | 'run' | 'search' | 'think' | 'tired' | 'wait';

/**
 * A live glyph: one per tool kind, plus compaction, which is an operation rather than a tool.
 */
export type LiveGlyphKind = AgentToolKind | 'compact';

export type WorkingIndicator = AppSettings['agentChat.workingIndicator'];

const MOOD_BY_KIND: Partial<Record<AgentToolKind, BuddyMood>> = {
    command: 'run',
    edit: 'run',
    list: 'search',
    read: 'read',
    search: 'search',
    wait: 'wait',
    web: 'read',
    write: 'run',
};

/**
 * Buddy's mood for the Chat's current activity. Kinds without a mood of their own (an MCP call, a plan update) think.
 */
export function buddyMood(activity: AgentChatActivity | undefined): BuddyMood {
    if (activity?.kind === 'compacting') return 'compact';
    if (activity?.kind === 'working' && activity.work)
        return MOOD_BY_KIND[activity.work.kind] ?? 'think';
    return 'think';
}

/**
 * How long one tool may run before Buddy gets tired of it.
 */
export const BUDDY_TIRED_AFTER_MS = 30_000;

/**
 * When Buddy gets tired of the running tool, in epoch milliseconds, or `undefined` when it never will: reasoning and an
 * explicit wait are not effort, and a tool without a start time cannot be timed.
 */
export function buddyTiredAt(activity: AgentChatActivity | undefined): number | undefined {
    if (activity?.kind !== 'working' || !activity.work) return undefined;
    const { kind, startedAt } = activity.work;
    if (kind === 'thought' || kind === 'wait' || startedAt === undefined) return undefined;
    return startedAt + BUDDY_TIRED_AFTER_MS;
}

/**
 * About one turn in this many gets a party hat.
 */
const PARTY_TURN_ODDS = 50;

/**
 * Whether Buddy wears a party hat for this turn: a rare cameo picked by hashing the turn id (FNV-1a), so it is stable
 * for the whole turn and across surfaces, and needs no stored state.
 */
export function isBuddyPartyTurn(turnId: string | undefined): boolean {
    if (!turnId) return false;
    let hash = 0x81_1c_9d_c5;
    const seed = `party:${turnId}`;
    for (const character of seed) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
    }
    return hash % PARTY_TURN_ODDS === 0;
}

export type StripIndicator =
    | { kind: 'buddy'; mood: BuddyMood }
    | { kind: 'glyph'; glyph: LiveGlyphKind }
    | { kind: 'spinner' };

/**
 * What leads the composer's status line while the Chat starts, works, or compacts. Buddy takes it when chosen as the
 * working indicator; otherwise the running tool's live glyph does when tool icons animate, and the spinner fills the
 * gaps between tools.
 */
export function stripIndicator(
    activity: Exclude<AgentChatActivity, { kind: 'waiting' }>,
    style: { workingIndicator: WorkingIndicator; animatesToolIcons: boolean },
): StripIndicator {
    if (style.workingIndicator === 'buddy') return { kind: 'buddy', mood: buddyMood(activity) };
    if (style.animatesToolIcons) {
        if (activity.kind === 'compacting') return { kind: 'glyph', glyph: 'compact' };
        if (activity.kind === 'working' && activity.work)
            return { kind: 'glyph', glyph: activity.work.kind };
    }
    return { kind: 'spinner' };
}
