import type {
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatTurn,
    AgentChatTurnArtifacts,
    AgentChatTurnFoldSegment,
    AgentChatTurnMetrics,
    AgentChatWorkItem,
} from '@caxri/protocol';
import {
    agentChatFinalReplyId,
    agentChatFoldTiming,
    collectAgentChatTurnArtifacts,
    foldAgentChatTurn,
    isAgentChatAwaitingReply,
    isAgentChatItemVisible,
    isAgentChatWorkItem,
} from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { agentChatMessageFullTime } from './agent-chat-time';

/**
 * One rendered row of the Chat timeline. Consecutive work collapses into one `work` entry, and a finished turn folds
 * everything but the prompt, the final reply, and notices into a `turn` entry (one per steered segment).
 */
export type AgentChatTimelineEntry =
    | {
          kind: 'item';
          item: Exclude<AgentChatItem, AgentChatWorkItem>;
          /**
           * The reply that ends a finished turn, the only one that carries a Copy action. Commentary between tool calls
           * stays action-free so the transcript does not reserve a row under every reply.
           */
          isFinalReply?: true;
          /**
           * What the finished turn this reply ends changed and filed, shown under the reply above its Copy action.
           */
          artifacts?: AgentChatTurnArtifacts;
          /**
           * The finished turn's generation speed and cost, shown after the reply's time when the turn has no fold row
           * to show them. Absent for a turn that ended before Caxri recorded them, so a replayed history shows only the
           * time.
           */
          metrics?: AgentChatTurnMetrics;
      }
    | {
          kind: 'work';
          id: string;
          items: readonly AgentChatWorkItem[];
          /**
           * The running turn's trailing run of work, which the next tool call still joins. A settled run of one call
           * renders as its own row; an open one keeps the summary so a second call does not reshape the row.
           */
          isOpen?: true;
          /**
           * The thinking the Agent answered a steered message with before going straight back to tools
           * (`agentChatSteerReplyThoughtIds`), which renders expanded because it is the only answer the user gets.
           */
          isSteerReply?: true;
      }
    | {
          /**
           * A finished turn's artifacts when the turn ended without a reply to carry them, such as a stopped turn.
           */
          kind: 'artifacts';
          id: string;
          artifacts: AgentChatTurnArtifacts;
      }
    | {
          kind: 'turn';
          id: string;
          /**
           * How long the turn (or its steered segment) ran, for its fold row's label (`agentChatTurnLabel`), translated
           * where it renders.
           */
          durationMs?: number;
          /**
           * How the turn ended, so a failed or stopped turn's fold row carries its tone, not only its words.
           */
          status: AgentChatTurn['status'];
          stoppedBy?: AgentChatTurn['stoppedBy'];
          /**
           * When the turn started and ended (epoch ms), for the fold row's tooltip; absent when the provider did not
           * say.
           */
          startedAt?: number;
          endedAt?: number;
          /**
           * The finished turn's recorded steps, tokens, and cost, on the row that closes the turn so a steered turn
           * shows them once. Absent for a turn that ended before Caxri recorded them.
           */
          metrics?: AgentChatTurnMetrics;
          /**
           * The folded work. Empty for a stopped turn that did no work: its row then only says how it ended.
           */
          entries: ReadonlyArray<Exclude<AgentChatTimelineEntry, { kind: 'turn' }>>;
      };

type FlatEntry = Exclude<AgentChatTimelineEntry, { kind: 'turn' }>;

const NO_STEER_REPLIES: ReadonlySet<string> = new Set();

/**
 * The reasoning that opens the Agent's response to each message steered into its turn, when a tool call rather than an
 * Agent message follows it. A model sometimes answers the steer only in its thinking and goes straight back to work,
 * and a collapsed `Thought` row then hides the only answer the user got, which reads as the steer being ignored. A
 * reasoning run still streaming, or one followed by a reply, is left alone: the reply is the answer.
 */
function agentChatSteerReplyThoughtIds(items: readonly AgentChatItem[]): ReadonlySet<string> {
    const ids = new Set<string>();
    let pending: string[] | undefined;
    for (const item of items) {
        if (!isAgentChatItemVisible(item)) continue;
        if (item.type === 'userMessage') {
            pending = item.delivery === 'steered' ? [] : undefined;
            continue;
        }
        if (!pending) continue;
        if (item.type === 'reasoning') {
            pending.push(item.id);
            continue;
        }
        if (isAgentChatWorkItem(item)) for (const id of pending) ids.add(id);
        pending = undefined;
    }
    return ids.size === 0 ? NO_STEER_REPLIES : ids;
}

function groupWork(
    items: readonly AgentChatItem[],
    finalReplyId?: string,
    isRunning = false,
    steerReplies = NO_STEER_REPLIES,
): FlatEntry[] {
    const entries: FlatEntry[] = [];
    let work: AgentChatWorkItem[] = [];
    let isSteerReply = false;
    const flush = (isOpen = false): void => {
        const first = work.at(0);
        if (first)
            entries.push({
                kind: 'work',
                id: `work:${first.id}`,
                items: work,
                ...(isOpen && { isOpen: true as const }),
                ...(isSteerReply && { isSteerReply: true as const }),
            });
        work = [];
    };
    for (const item of items) {
        if (!isAgentChatItemVisible(item)) continue;
        if (isAgentChatWorkItem(item)) {
            // A steer's reply thought gets its own entry, so it renders as an expanded row instead of joining the
            // collapsed summary of the tool calls after it.
            const isReply = steerReplies.has(item.id);
            if (isReply !== isSteerReply) flush();
            isSteerReply = isReply;
            work.push(item);
            continue;
        }
        flush();
        entries.push({
            kind: 'item',
            item,
            ...(item.id === finalReplyId && { isFinalReply: true }),
        });
    }
    flush(isRunning);
    return entries;
}

/**
 * The fold row's tooltip: when the turn finished, or when it started if its end is unknown.
 */
export function agentChatTurnTimeTooltip(
    entry: Pick<Extract<AgentChatTimelineEntry, { kind: 'turn' }>, 'endedAt' | 'startedAt'>,
    t: Translate,
): string | undefined {
    if (entry.endedAt !== undefined)
        return t('agentChat.fold.finishedAt', {
            time: agentChatMessageFullTime(entry.endedAt, t.locale),
        });
    if (entry.startedAt !== undefined)
        return t('agentChat.fold.startedAt', {
            time: agentChatMessageFullTime(entry.startedAt, t.locale),
        });
    return undefined;
}

/**
 * The semantic tone of a finished turn's fold row: a failed turn is `danger`, a turn that stopped without the user
 * asking `warning`, and a turn the user stopped `stopped`, which keeps the stop glyph in muted ink because nothing went
 * wrong. A turn that completed stays quiet (`undefined`), because a column of green fold rows would be noise.
 */
export function agentChatTurnTone(
    turn: Pick<AgentChatTurn, 'status' | 'stoppedBy'>,
): 'danger' | 'stopped' | 'warning' | undefined {
    if (turn.status === 'failed') return 'danger';
    if (turn.status !== 'interrupted') return undefined;
    return turn.stoppedBy === 'user' ? 'stopped' : 'warning';
}

const WHOLE_TURN: AgentChatTurnFoldSegment = { index: 0, opensTurn: true, closesTurn: true };

/**
 * One fold row. A turn split by steered messages has a row per segment: each times its own segment, and only the
 * closing segment's row carries how the turn ended, since the earlier segments ran on after their reply. The first row
 * keeps the id `turn:<id>` a turn nobody steered has, so its expansion state survives.
 */
function turnEntry(
    turn: AgentChatTurn,
    entries: Extract<AgentChatTimelineEntry, { kind: 'turn' }>['entries'],
    segment: AgentChatTurnFoldSegment = WHOLE_TURN,
    hasOutcome = true,
): AgentChatTimelineEntry {
    const timing = agentChatFoldTiming(segment, turn);
    return {
        kind: 'turn',
        id: segment.index === 0 ? `turn:${turn.id}` : `turn:${turn.id}:${segment.index}`,
        status: hasOutcome ? turn.status : 'completed',
        ...(hasOutcome && turn.stoppedBy && { stoppedBy: turn.stoppedBy }),
        ...timing,
        ...(hasOutcome && turn.metrics && { metrics: turn.metrics }),
        entries,
    };
}

/**
 * A finished turn's work and commentary before the reply fold into a `turn` entry where `foldAgentChatTurn` (shared
 * with the phone) puts the fold, one per segment when messages were steered into the turn; the prompt, the final reply,
 * and its notices stay in view. A stopped turn whose closing segment has nothing to fold (a plain reply cut off, or no
 * reply yet) still gets an empty `turn` entry before that reply, so the transcript says it was stopped and by whom
 * instead of reading as a reply that simply ended there.
 */
function foldTurn(
    items: readonly AgentChatItem[],
    turn: AgentChatTurn,
    finalReplyId: string | undefined,
): AgentChatTimelineEntry[] {
    const visible = items.filter((item) => isAgentChatItemVisible(item));
    const parts = foldAgentChatTurn(visible, finalReplyId);
    const steerReplies = agentChatSteerReplyThoughtIds(visible);
    const entries: AgentChatTimelineEntry[] = parts.every((part) => part.kind === 'kept')
        ? groupWork(visible, finalReplyId, false, steerReplies)
        : parts.flatMap((part): AgentChatTimelineEntry[] =>
              part.kind === 'kept'
                  ? groupWork([part.item], finalReplyId)
                  : [
                        turnEntry(
                            turn,
                            groupWork(part.items, undefined, false, steerReplies),
                            part.segment,
                            part.segment.closesTurn,
                        ),
                    ],
          );
    const closing = parts.at(-1)?.segment ?? WHOLE_TURN;
    if (
        turn.status !== 'interrupted' ||
        parts.some((part) => part.kind === 'fold' && part.segment.closesTurn)
    )
        return entries;
    // The closing segment folded nothing, so its outcome row goes before its reply, or at the end without one.
    const opener = parts.find((part) => part.segment.index === closing.index);
    const openerIndex =
        opener?.kind === 'kept'
            ? entries.findIndex(
                  (entry) => entry.kind === 'item' && entry.item.id === opener.item.id,
              )
            : 0;
    const replyIndex = entries.findIndex((entry) => entry.kind === 'item' && entry.isFinalReply);
    return entries.toSpliced(
        replyIndex >= openerIndex ? replyIndex : entries.length,
        0,
        turnEntry(turn, [], closing),
    );
}

/**
 * The last artifacts computed per turn, reused while the turn's items keep their identities. The projection replaces
 * only the item a patch touches, so a reply streaming in a later turn does not hand every earlier final reply a new
 * `artifacts` object and re-render it.
 */
const artifactsCache = new WeakMap<
    AgentChatItem,
    {
        turnId: string;
        items: readonly AgentChatItem[];
        isPartial: boolean;
        artifacts: AgentChatTurnArtifacts | undefined;
    }
>();

function turnArtifacts(
    turnId: string,
    items: readonly AgentChatItem[],
    isPartial: boolean,
): AgentChatTurnArtifacts | undefined {
    const first = items.at(0);
    if (!first) return undefined;
    const cached = artifactsCache.get(first);
    if (
        cached?.turnId === turnId &&
        cached.isPartial === isPartial &&
        cached.items.length === items.length &&
        cached.items.every((item, index) => item === items[index])
    )
        return cached.artifacts;
    const collected = collectAgentChatTurnArtifacts(turnId, items);
    const artifacts =
        collected && isPartial ? { ...collected, isPartial: true as const } : collected;
    artifactsCache.set(first, { turnId, items, isPartial, artifacts });
    return artifacts;
}

/**
 * Hangs a finished turn's artifacts on its final reply, or appends them after the turn when it has none.
 */
function withTurnArtifacts(
    entries: AgentChatTimelineEntry[],
    artifacts: AgentChatTurnArtifacts | undefined,
): AgentChatTimelineEntry[] {
    if (!artifacts) return entries;
    const replyIndex = entries.findIndex((entry) => entry.kind === 'item' && entry.isFinalReply);
    const reply = replyIndex === -1 ? undefined : entries[replyIndex];
    if (reply?.kind !== 'item')
        return [...entries, { kind: 'artifacts', id: `artifacts:${artifacts.turnId}`, artifacts }];
    return entries.with(replyIndex, { ...reply, artifacts });
}

/**
 * Hangs a finished turn's recorded metrics on its final reply when no fold row shows them: a turn that only answered,
 * with no work to fold, keeps its speed and cost in the reply's action row. A turn without a reply has no footer to
 * carry them.
 */
function withTurnMetrics(
    entries: AgentChatTimelineEntry[],
    metrics: AgentChatTurnMetrics | undefined,
): AgentChatTimelineEntry[] {
    if (!metrics) return entries;
    if (entries.some((entry) => entry.kind === 'turn' && entry.metrics && entry.entries.length > 0))
        return entries;
    const replyIndex = entries.findIndex((entry) => entry.kind === 'item' && entry.isFinalReply);
    const reply = replyIndex === -1 ? undefined : entries[replyIndex];
    if (reply?.kind !== 'item') return entries;
    return entries.with(replyIndex, { ...reply, metrics });
}

/**
 * Builds the rendered timeline from the projection. Items arrive in order and each turn's items are contiguous, so a
 * run of items sharing a `turnId` is one turn. A turn still running (or with no recorded end) stays expanded. Every
 * turn not running ends on its last reply, which is the only one marked `isFinalReply`; a running turn's latest reply
 * may still be followed by more work, so it is not marked until the turn ends.
 *
 * `isTruncated` says older items were dropped before `items`. The first turn then may have lost its start, so its
 * artifacts are marked `isPartial` unless it still opens on its prompt.
 */
export function buildAgentChatTimeline(
    items: readonly AgentChatItem[],
    turns: readonly AgentChatTurn[],
    activeTurnId: string | undefined,
    isTruncated = false,
): AgentChatTimelineEntry[] {
    const finished = new Map(
        turns
            .filter((turn) => turn.status !== 'running' && turn.id !== activeTurnId)
            .map((turn) => [turn.id, turn]),
    );
    const running = new Set(
        turns.filter((turn) => turn.status === 'running').map((turn) => turn.id),
    );
    if (activeTurnId !== undefined) running.add(activeTurnId);
    const entries: AgentChatTimelineEntry[] = [];
    let start = 0;
    while (start < items.length) {
        const turnId = items[start]?.turnId;
        let end = start + 1;
        while (end < items.length && items[end]?.turnId === turnId) end += 1;
        const segment = items.slice(start, end);
        const turn = turnId === undefined ? undefined : finished.get(turnId);
        const finalReplyId =
            turnId !== undefined && running.has(turnId)
                ? undefined
                : agentChatFinalReplyId(segment);
        const artifacts =
            turn &&
            turnArtifacts(
                turn.id,
                segment,
                start === 0 && isTruncated && segment[0]?.type !== 'userMessage',
            );
        const folded = turn && withTurnArtifacts(foldTurn(segment, turn, finalReplyId), artifacts);
        entries.push(
            ...(turn && folded
                ? withTurnMetrics(folded, turn.metrics)
                : groupWork(
                      segment,
                      finalReplyId,
                      turnId !== undefined && running.has(turnId),
                      agentChatSteerReplyThoughtIds(segment),
                  )),
        );
        start = end;
    }
    return reuseAgentChatTimelineEntries(entries);
}

/**
 * Marks the first rendered entry of each turn with that turn's id, so a jump can land where a turn begins even when no
 * prompt opens it (a turn a background task or `/goal` started). A turn split across lists is marked in each; the
 * earliest match in document order is where it begins.
 */
export const AGENT_CHAT_TURN_START_ATTRIBUTE = 'data-agent-chat-turn-start';

/**
 * The turn `entry` belongs to, or `undefined` when it carries no item to tell (a stopped turn's empty fold row).
 */
function agentChatTimelineEntryTurnId(entry: AgentChatTimelineEntry): string | undefined {
    return entry.kind === 'artifacts' ? entry.artifacts.turnId : firstItem(entry)?.turnId;
}

/**
 * The turn `entry` opens in its list (`AGENT_CHAT_TURN_START_ATTRIBUTE`), or `undefined` when it continues the turn of
 * the entry before it.
 */
export function agentChatTurnStartId(
    entry: AgentChatTimelineEntry,
    previous: AgentChatTimelineEntry | undefined,
): string | undefined {
    const turnId = agentChatTimelineEntryTurnId(entry);
    if (turnId === undefined) return undefined;
    return previous && agentChatTimelineEntryTurnId(previous) === turnId ? undefined : turnId;
}

/**
 * The stable React key of one timeline entry.
 */
export function agentChatTimelineEntryKey(entry: AgentChatTimelineEntry): string {
    return entry.kind === 'item' ? entry.item.id : entry.id;
}

/**
 * Whether the running turn still shows nothing after the user's message (`isAgentChatAwaitingReply` in protocol).
 */
export function isAgentChatAwaitingReplyInTimeline(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'operation' | 'requests'> | undefined,
    timeline: readonly AgentChatTimelineEntry[],
): boolean {
    const last = timeline.at(-1);
    return isAgentChatAwaitingReply(
        snapshot,
        last?.kind === 'item' && last.item.type === 'userMessage',
    );
}

type Entry<Kind extends AgentChatTimelineEntry['kind']> = Extract<
    AgentChatTimelineEntry,
    { kind: Kind }
>;

/**
 * The last entry built per anchor object, one table per kind so a turn and the first work group inside it, which share
 * their first item, never collide. The projection replaces only the item a patch touches, so an entry whose source
 * items kept their identities is structurally the same entry; handing back the previous one keeps its props stable and
 * lets the row skip rendering while a later turn streams.
 */
const items = new WeakMap<AgentChatItem, Entry<'item'>>();
const works = new WeakMap<AgentChatItem, Entry<'work'>>();
const turns = new WeakMap<AgentChatItem, Entry<'turn'>>();
const artifactLists = new WeakMap<AgentChatTurnArtifacts, Entry<'artifacts'>>();

function areSameEntries(
    left: readonly AgentChatTimelineEntry[],
    right: readonly AgentChatTimelineEntry[],
): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * Compared by value: every `state` patch replaces the `turns` array, and a fresh but equal metrics object must not
 * re-render a settled reply.
 */
function isSameTurnMetrics(
    left: AgentChatTurnMetrics | undefined,
    right: AgentChatTurnMetrics | undefined,
): boolean {
    return (
        left?.outputTokens === right?.outputTokens &&
        left?.generationMs === right?.generationMs &&
        left?.speed === right?.speed &&
        left?.costUsd === right?.costUsd &&
        left?.requests === right?.requests &&
        left?.totalTokens === right?.totalTokens
    );
}

function firstItem(entry: AgentChatTimelineEntry): AgentChatItem | undefined {
    switch (entry.kind) {
        case 'item': {
            return entry.item;
        }
        case 'work': {
            return entry.items[0];
        }
        case 'turn': {
            return entry.entries.map((child) => firstItem(child)).find(Boolean);
        }
        case 'artifacts': {
            return undefined;
        }
    }
}

/**
 * The entry itself, or the equal one built before when its source items kept their identities. Children of a `turn`
 * entry are reused first, so the comparison is a shallow identity check.
 */
function reuseAgentChatTimelineEntry(entry: AgentChatTimelineEntry): AgentChatTimelineEntry {
    switch (entry.kind) {
        case 'item': {
            const previous = items.get(entry.item);
            if (
                previous &&
                previous.isFinalReply === entry.isFinalReply &&
                previous.artifacts === entry.artifacts &&
                isSameTurnMetrics(previous.metrics, entry.metrics)
            )
                return previous;
            items.set(entry.item, entry);
            return entry;
        }
        case 'work': {
            const anchor = entry.items[0];
            const previous = works.get(anchor);
            if (
                previous &&
                previous.id === entry.id &&
                previous.isOpen === entry.isOpen &&
                previous.isSteerReply === entry.isSteerReply &&
                previous.items.length === entry.items.length &&
                previous.items.every((item, index) => item === entry.items[index])
            )
                return previous;
            works.set(anchor, entry);
            return entry;
        }
        case 'artifacts': {
            const previous = artifactLists.get(entry.artifacts);
            if (previous && previous.id === entry.id) return previous;
            artifactLists.set(entry.artifacts, entry);
            return entry;
        }
        case 'turn': {
            const children = entry.entries.map((child) => reuseAgentChatTimelineEntry(child));
            const next = areSameEntries(children, entry.entries)
                ? entry
                : { ...entry, entries: children as Entry<'turn'>['entries'] };
            const anchor = firstItem(next);
            // A stopped turn that did no work has nothing to anchor on, so it is rebuilt each time.
            if (!anchor) return next;
            const previous = turns.get(anchor);
            if (
                previous &&
                previous.id === next.id &&
                previous.status === next.status &&
                previous.stoppedBy === next.stoppedBy &&
                previous.durationMs === next.durationMs &&
                previous.startedAt === next.startedAt &&
                previous.endedAt === next.endedAt &&
                isSameTurnMetrics(previous.metrics, next.metrics) &&
                areSameEntries(previous.entries, next.entries)
            )
                return previous;
            turns.set(anchor, next);
            return next;
        }
    }
}

/**
 * Applies {@link reuseAgentChatTimelineEntry} to a built timeline.
 */
function reuseAgentChatTimelineEntries(
    entries: readonly AgentChatTimelineEntry[],
): AgentChatTimelineEntry[] {
    return entries.map((entry) => reuseAgentChatTimelineEntry(entry));
}
