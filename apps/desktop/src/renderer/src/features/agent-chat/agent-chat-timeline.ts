import type {
    AgentChatItem,
    AgentChatTurn,
    AgentChatTurnArtifacts,
    AgentChatWorkItem,
    AgentToolPresentation,
} from '@caxri/protocol';
import {
    agentChatFinalReplyId,
    agentChatWorkSummaryTools,
    collectAgentChatTurnArtifacts,
    describeAgentChatWorkAction,
    foldAgentChatTurn,
    formatNoticeableDuration,
    isAgentChatItemVisible,
    isAgentChatWorkUnsuccessful,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { agentChatMessageFullTime } from './agent-chat-time';
import {
    agentChatToolGroupSummary,
    agentChatToolLabel,
    agentChatToolOutcomeLabel,
} from './agent-chat-tool-labels';

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
          /**
           * The final reply of the most recent turn: its Copy action stays visible instead of waiting for hover, since
           * it is the reply the user most likely wants to take away. Earlier replies reveal theirs on hover or focus.
           */
          isLatestReply?: true;
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
          /**
           * When the turn started and ended (epoch ms), for the fold row's tooltip; absent when the provider did not
           * say.
           */
          startedAt?: number;
          endedAt?: number;
          entries: ReadonlyArray<Exclude<AgentChatTimelineEntry, { kind: 'turn' }>>;
      };

type FlatEntry = Exclude<AgentChatTimelineEntry, { kind: 'turn' }>;

const WORK_ITEM_TYPES: ReadonlySet<AgentChatItem['type']> = new Set([
    'command',
    'fileChange',
    'reasoning',
    'toolCall',
]);

const isWorkItem = (item: AgentChatItem): item is AgentChatWorkItem =>
    WORK_ITEM_TYPES.has(item.type);

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
        if (isWorkItem(item)) {
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
 * `Worked for 2m 1s`, or how a turn that did not complete ended, in the active language; the phone reads the English
 * `agentChatTurnLabel` in `@caxri/protocol`. A turn under a second reads as plain `Worked`, as a work row drops its
 * sub-second duration: `<1s` is noise.
 */
export function agentChatTurnLabel(
    turn: Pick<AgentChatTurn, 'durationMs' | 'status'>,
    t: Translate = translate,
): string {
    const duration = formatNoticeableDuration(turn.durationMs);
    if (duration)
        return t(
            turn.status === 'interrupted'
                ? 'agentChat.fold.stoppedAfter'
                : turn.status === 'failed'
                  ? 'agentChat.fold.failedAfter'
                  : 'agentChat.fold.workedFor',
            { duration },
        );
    return t(
        turn.status === 'interrupted'
            ? 'agentChat.fold.stopped'
            : turn.status === 'failed'
              ? 'agentChat.fold.failed'
              : 'agentChat.fold.worked',
    );
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
 * The semantic tone of a finished turn's fold row: a failed turn is `danger`, a stopped one `warning`, and a turn that
 * completed stays quiet (`undefined`), because a column of green fold rows would be noise.
 */
export function agentChatTurnTone(
    status: AgentChatTurn['status'],
): 'danger' | 'warning' | undefined {
    if (status === 'failed') return 'danger';
    return status === 'interrupted' ? 'warning' : undefined;
}

/**
 * A finished turn's work and commentary before the reply fold into one `turn` entry where `foldAgentChatTurn` (shared
 * with the phone) puts the fold; the prompt, the final reply, and its notices stay in view.
 */
function foldTurn(
    items: readonly AgentChatItem[],
    turn: AgentChatTurn,
    finalReplyId: string | undefined,
): AgentChatTimelineEntry[] {
    const visible = items.filter((item) => isAgentChatItemVisible(item));
    const parts = foldAgentChatTurn(visible, finalReplyId);
    if (parts.every((part) => part.kind === 'kept')) return groupWork(visible, finalReplyId);
    return parts.flatMap((part): AgentChatTimelineEntry[] =>
        part.kind === 'kept'
            ? groupWork([part.item], finalReplyId)
            : [
                  {
                      kind: 'turn',
                      id: `turn:${turn.id}`,
                      status: turn.status,
                      ...(turn.durationMs !== undefined && { durationMs: turn.durationMs }),
                      ...(turn.startedAt !== undefined && { startedAt: turn.startedAt }),
                      ...(turn.startedAt !== undefined &&
                          turn.durationMs !== undefined && {
                              endedAt: turn.startedAt + turn.durationMs,
                          }),
                      entries: groupWork(part.items),
                  },
              ],
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
        artifacts: AgentChatTurnArtifacts | undefined;
    }
>();

function turnArtifacts(
    turnId: string,
    items: readonly AgentChatItem[],
): AgentChatTurnArtifacts | undefined {
    const first = items.at(0);
    if (!first) return undefined;
    const cached = artifactsCache.get(first);
    if (
        cached?.turnId === turnId &&
        cached.items.length === items.length &&
        cached.items.every((item, index) => item === items[index])
    )
        return cached.artifacts;
    const artifacts = collectAgentChatTurnArtifacts(turnId, items);
    artifactsCache.set(first, { turnId, items, artifacts });
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
 * may still be followed by more work, so it is not marked until the turn ends. The last turn's final reply is also
 * `isLatestReply`; while the last turn still runs, no reply is. History read back from before the live projection is
 * built with `hasLatestReply` off, since the latest reply is always in the live part.
 */
export function buildAgentChatTimeline(
    items: readonly AgentChatItem[],
    turns: readonly AgentChatTurn[],
    activeTurnId: string | undefined,
    hasLatestReply = true,
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
    let latestReplyId: string | undefined;
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
                      turnArtifacts(turn.id, segment),
                  )
                : groupWork(segment, finalReplyId)),
        );
        latestReplyId = finalReplyId;
        start = end;
    }
    return latestReplyId === undefined || !hasLatestReply
        ? entries
        : entries.map((entry) =>
              entry.kind === 'item' && entry.item.id === latestReplyId
                  ? { ...entry, isLatestReply: true }
                  : entry,
          );
}

/**
 * The stable React key of one timeline entry.
 */
export function agentChatTimelineEntryKey(entry: AgentChatTimelineEntry): string {
    return entry.kind === 'item' ? entry.item.id : entry.id;
}

/**
 * The kind, verb, and subject a work row shows, in the active language. The rules live in `@caxri/protocol`
 * (`describeAgentChatWorkAction`), shared with the phone; this translates the English verb and the file count. A
 * settled item that did not complete names its outcome in the verb (`Failed to edit`), so the title tells the truth on
 * its own.
 */
export function describeAgentChatWork(
    item: AgentChatWorkItem,
    t: Translate = translate,
): AgentToolPresentation {
    const action = describeAgentChatWorkAction(item);
    const first = item.type === 'fileChange' ? item.changes.at(0) : undefined;
    const presentation = {
        ...action,
        label: agentChatToolLabel(action.label, t),
        ...(item.type === 'fileChange' &&
            first &&
            item.changes.length > 1 && {
                subject: t('agentChat.tool.moreFiles', {
                    name: pathBasename(first.path),
                    count: item.changes.length - 1,
                }),
            }),
    };
    if (item.type === 'reasoning' || item.status === 'running') return presentation;
    return { ...presentation, label: agentChatToolOutcomeLabel(presentation, item.status, t) };
}

/**
 * `Ran 3 commands, read 2 files` for a group in the active language, counting each changed file as one edit; the phone
 * reads the English `summarizeAgentChatWork` in `@caxri/protocol`. Reasoning only names the group when it is all the
 * group holds. Items that failed or were declined are counted at the end (`, 1 failed`), so a collapsed group never
 * reads as a clean run.
 */
export function summarizeAgentChatWork(
    items: readonly AgentChatWorkItem[],
    t: Translate = translate,
): string {
    const tools = agentChatWorkSummaryTools(items);
    if (tools.length === 0)
        return t(
            items.some((item) => item.type === 'reasoning' && item.streaming)
                ? 'agentChat.tool.label.thinking'
                : 'agentChat.tool.label.thought',
        );
    const failed = items.filter((item) => isAgentChatWorkUnsuccessful(item)).length;
    const summary = agentChatToolGroupSummary(tools, t);
    return failed > 0 ? t('agentChat.workGroup.withFailures', { summary, count: failed }) : summary;
}
