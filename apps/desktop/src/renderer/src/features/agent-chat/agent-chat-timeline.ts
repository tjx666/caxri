import type {
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatTurn,
    AgentChatTurnArtifacts,
    AgentChatWorkItem,
} from '@caxri/protocol';
import {
    agentChatFinalReplyId,
    collectAgentChatTurnArtifacts,
    foldAgentChatTurn,
    isAgentChatAwaitingReply,
    isAgentChatItemVisible,
    isAgentChatWorkItem,
    parseAgentMcpToolName,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { agentChatMessageFullTime } from './agent-chat-time';

/**
 * One rendered row of the Chat timeline. Consecutive work collapses into one `work` entry, and a finished turn folds
 * everything but the prompt, the final reply, and notices into one `turn` entry.
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
      }
    | { kind: 'work'; id: string; items: readonly AgentChatWorkItem[] }
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
           * How long the turn ran, for its fold row's label (`agentChatTurnLabel`), translated where it renders.
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
           * The folded work. Empty for a stopped turn that did no work: its row then only says how it ended.
           */
          entries: ReadonlyArray<Exclude<AgentChatTimelineEntry, { kind: 'turn' }>>;
      };

type FlatEntry = Exclude<AgentChatTimelineEntry, { kind: 'turn' }>;

function groupWork(items: readonly AgentChatItem[], finalReplyId?: string): FlatEntry[] {
    const entries: FlatEntry[] = [];
    let work: AgentChatWorkItem[] = [];
    const flush = (): void => {
        const first = work.at(0);
        if (first) entries.push({ kind: 'work', id: `work:${first.id}`, items: work });
        work = [];
    };
    for (const item of items) {
        if (!isAgentChatItemVisible(item)) continue;
        if (isAgentChatWorkItem(item)) {
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
    flush();
    return entries;
}

/**
 * The fold row's tooltip: when the turn finished, or when it started if its end is unknown.
 */
export function agentChatTurnTimeTooltip(
    entry: Pick<Extract<AgentChatTimelineEntry, { kind: 'turn' }>, 'endedAt' | 'startedAt'>,
    t: Translate = translate,
): string | undefined {
    if (entry.endedAt !== undefined)
        return t('agentChat.fold.finishedAt', { time: agentChatMessageFullTime(entry.endedAt) });
    if (entry.startedAt !== undefined)
        return t('agentChat.fold.startedAt', { time: agentChatMessageFullTime(entry.startedAt) });
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

function turnEntry(
    turn: AgentChatTurn,
    entries: Extract<AgentChatTimelineEntry, { kind: 'turn' }>['entries'],
): AgentChatTimelineEntry {
    return {
        kind: 'turn',
        id: `turn:${turn.id}`,
        status: turn.status,
        ...(turn.stoppedBy && { stoppedBy: turn.stoppedBy }),
        ...(turn.durationMs !== undefined && { durationMs: turn.durationMs }),
        ...(turn.startedAt !== undefined && { startedAt: turn.startedAt }),
        ...(turn.startedAt !== undefined &&
            turn.durationMs !== undefined && {
                endedAt: turn.startedAt + turn.durationMs,
            }),
        entries,
    };
}

/**
 * A finished turn's work and commentary before the reply fold into one `turn` entry where `foldAgentChatTurn` (shared
 * with the phone) puts the fold; the prompt, the final reply, and its notices stay in view. A stopped turn with nothing
 * to fold (a plain reply cut off, or no reply yet) still gets an empty `turn` entry before its reply, so the transcript
 * says it was stopped and by whom instead of reading as a reply that simply ended there.
 */
function foldTurn(
    items: readonly AgentChatItem[],
    turn: AgentChatTurn,
    finalReplyId: string | undefined,
): AgentChatTimelineEntry[] {
    const visible = items.filter((item) => isAgentChatItemVisible(item));
    const parts = foldAgentChatTurn(visible, finalReplyId);
    if (parts.every((part) => part.kind === 'kept')) {
        const kept: AgentChatTimelineEntry[] = groupWork(visible, finalReplyId);
        if (turn.status !== 'interrupted') return kept;
        const replyIndex = kept.findIndex((entry) => entry.kind === 'item' && entry.isFinalReply);
        return kept.toSpliced(replyIndex === -1 ? kept.length : replyIndex, 0, turnEntry(turn, []));
    }
    return parts.flatMap((part): AgentChatTimelineEntry[] =>
        part.kind === 'kept'
            ? groupWork([part.item], finalReplyId)
            : [turnEntry(turn, groupWork(part.items))],
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
        entries.push(
            ...(turn
                ? withTurnArtifacts(
                      foldTurn(segment, turn, finalReplyId),
                      turnArtifacts(
                          turn.id,
                          segment,
                          start === 0 && isTruncated && segment[0]?.type !== 'userMessage',
                      ),
                  )
                : groupWork(segment, finalReplyId)),
        );
        start = end;
    }
    return entries;
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
