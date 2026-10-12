import type {
    AgentChatDiffLine,
    AgentChatFileChange,
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatTurn,
    AgentChatTurnArtifacts,
    AgentChatWorkItem,
    AgentTimelineItem,
} from '@caxri/protocol';
import {
    agentChatFinalReplyId,
    agentChatNoticeMessage,
    agentChatTurnLabel,
    collectAgentChatTurnArtifacts,
    foldAgentChatTurn,
    isAgentChatItemVisible,
    splitAgentChatWork,
} from '@caxri/protocol';

import type { DiffLine } from '../changes/changes-model';

/**
 * A message the shared Conversation renderer draws as it draws a terminal Agent's: the user's bubble, a Markdown reply,
 * or a notice row.
 */
type AgentChatMessageEntry = Extract<
    AgentTimelineItem,
    { type: 'agentMessage' | 'systemEvent' | 'userMessage' }
>;

/**
 * One row of the phone's Chat timeline. Consecutive work becomes one `work` entry, split the way Desktop splits it
 * (`splitAgentChatWork`): settled work into a summary row once it holds two tool calls, and work still running as its
 * own live rows. A finished turn folds its work and commentary behind its `Worked for` row (`turn`) the way Desktop
 * does (`foldAgentChatTurn`), and ends with what it left behind (`artifacts`) under its final reply.
 */
export type AgentChatTimelineEntry =
    | { kind: 'message'; id: string; message: AgentChatMessageEntry }
    | {
          kind: 'work';
          id: string;
          summarized: readonly AgentChatWorkItem[];
          rows: readonly AgentChatWorkItem[];
      }
    | { kind: 'artifacts'; id: string; artifacts: AgentChatTurnArtifacts }
    | {
          kind: 'turn';
          id: string;
          turnId: string;
          label: string;
          status: AgentChatTurn['status'];
          /**
           * Whether the row toggles the turn's folded work, which then follows it as ordinary entries. Absent when the
           * turn had nothing to fold (a prompt and its reply), so the row only says how the turn went.
           */
          fold?: 'collapsed' | 'expanded';
      }
    | {
          /**
           * A message on its way that starts or steers a turn (`agent-chat-pending.ts`), drawn like the user message it
           * becomes but faded and captioned `Sending…`.
           */
          kind: 'pending';
          id: string;
          text: string;
          imageUris: readonly string[];
      };

const WORK_TYPES: ReadonlySet<AgentChatItem['type']> = new Set([
    'command',
    'fileChange',
    'reasoning',
    'toolCall',
]);

const isWorkItem = (item: AgentChatItem): item is AgentChatWorkItem => WORK_TYPES.has(item.type);

const toMessage = (
    item: Extract<AgentChatItem, { type: 'agentMessage' | 'notice' | 'userMessage' }>,
): AgentChatMessageEntry => {
    switch (item.type) {
        case 'userMessage':
        case 'agentMessage': {
            return { id: item.id, type: item.type, text: item.text };
        }
        case 'notice': {
            return {
                id: item.id,
                type: 'systemEvent',
                kind: 'caveat',
                summary: agentChatNoticeMessage(item).slice(0, 240),
                ...(item.kind === 'error' && { status: 'failed' as const }),
            };
        }
    }
};

/**
 * Visible items as entries, consecutive work grouped into one `work` entry.
 */
function groupEntries(visible: readonly AgentChatItem[]): AgentChatTimelineEntry[] {
    const entries: AgentChatTimelineEntry[] = [];
    let work: AgentChatWorkItem[] = [];
    const flush = (): void => {
        const first = work.at(0);
        if (first)
            entries.push({ kind: 'work', id: `work:${first.id}`, ...splitAgentChatWork(work) });
        work = [];
    };
    for (const item of visible) {
        if (isWorkItem(item)) {
            work.push(item);
            continue;
        }
        flush();
        entries.push({ kind: 'message', id: item.id, message: toMessage(item) });
    }
    flush();
    return entries;
}

/**
 * A finished turn's entries. Collapsed, the turn reads as its prompt, the `Worked for` row, its final reply with the
 * artifacts under it, and its notices; expanded, the folded work follows the row. A turn with nothing to fold still
 * gets the row, just before its reply, so how long it ran and how it ended stay in view.
 */
function finishedTurnEntries(
    visible: readonly AgentChatItem[],
    turn: AgentChatTurn,
    artifacts: AgentChatTurnArtifacts | undefined,
    isExpanded: boolean,
): AgentChatTimelineEntry[] {
    const finalReplyId = agentChatFinalReplyId(visible);
    const parts = foldAgentChatTurn(visible, finalReplyId);
    const row = (
        fold: 'collapsed' | 'expanded' | undefined,
    ): Extract<AgentChatTimelineEntry, { kind: 'turn' }> => ({
        kind: 'turn',
        id: `turn:${turn.id}`,
        turnId: turn.id,
        label: agentChatTurnLabel(turn),
        status: turn.status,
        ...(fold && { fold }),
    });
    const artifactsEntry: AgentChatTimelineEntry[] = artifacts
        ? [{ kind: 'artifacts', id: `artifacts:${artifacts.turnId}`, artifacts }]
        : [];
    const hasFold = parts.some((part) => part.kind === 'fold');
    const entries: AgentChatTimelineEntry[] = [];
    for (const part of parts) {
        if (part.kind === 'fold') {
            entries.push(row(isExpanded ? 'expanded' : 'collapsed'));
            if (isExpanded) entries.push(...groupEntries(part.items));
            continue;
        }
        if (!hasFold && part.item.id === finalReplyId) entries.push(row(undefined));
        entries.push(...groupEntries([part.item]));
        if (part.item.id === finalReplyId) entries.push(...artifactsEntry);
    }
    if (!hasFold && finalReplyId === undefined) entries.push(row(undefined));
    if (finalReplyId === undefined) entries.push(...artifactsEntry);
    return entries;
}

/**
 * Builds the phone's Chat timeline from the projection. Items arrive in order and each turn's items are contiguous, so
 * a run of items sharing a `turnId` is one turn. Only a finished turn (not running and not the active one) folds and
 * gets artifacts, so a running turn stays live and never claims a result it has not reached. `expandedTurnIds` names
 * the finished turns the user unfolded; the list owns it rather than a row, so a recycled row never carries another
 * turn's state. When the window cut older items (`truncated`), the oldest turn may be missing its start, so it shows no
 * artifacts rather than an incomplete summary.
 */
export function buildAgentChatTimeline(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'> &
        Partial<Pick<AgentChatSnapshot, 'truncated'>>,
    expandedTurnIds: ReadonlySet<string> = new Set(),
): AgentChatTimelineEntry[] {
    const { activeTurnId, items, turns } = snapshot;
    const finished = new Map(
        turns
            .filter((turn) => turn.status !== 'running' && turn.id !== activeTurnId)
            .map((turn) => [turn.id, turn]),
    );
    const entries: AgentChatTimelineEntry[] = [];
    let start = 0;
    while (start < items.length) {
        const turnId = items[start]?.turnId;
        let end = start + 1;
        while (end < items.length && items[end]?.turnId === turnId) end += 1;
        const segment = items.slice(start, end);
        const visible = segment.filter((item) => isAgentChatItemVisible(item));
        const turn = turnId === undefined ? undefined : finished.get(turnId);
        const isComplete = start > 0 || snapshot.truncated !== true;
        entries.push(
            ...(turn
                ? finishedTurnEntries(
                      visible,
                      turn,
                      isComplete ? collectAgentChatTurnArtifacts(turn.id, segment) : undefined,
                      expandedTurnIds.has(turn.id),
                  )
                : groupEntries(visible)),
        );
        start = end;
    }
    return entries;
}

/**
 * The expanded-turn set after the user taps a turn's `Worked for` row.
 */
export function toggleAgentChatTurn(
    expandedTurnIds: ReadonlySet<string>,
    turnId: string,
): ReadonlySet<string> {
    const next = new Set(expandedTurnIds);
    if (!next.delete(turnId)) next.add(turnId);
    return next;
}

/**
 * The semantic tone of a finished turn's footer, as Desktop tones its fold row: a failed turn is `danger`, a stopped
 * one `warning`, and a completed one stays quiet.
 */
export function agentChatTurnTone(status: AgentChatTurn['status']): 'danger' | 'muted' | 'warning' {
    if (status === 'failed') return 'danger';
    return status === 'interrupted' ? 'warning' : 'muted';
}

const DIFF_MARKER: Record<AgentChatDiffLine['kind'], DiffLine['marker']> = {
    added: '+',
    removed: '−',
    context: ' ',
    hunk: ' ',
    meta: ' ',
};

/**
 * A Chat file change's display lines in the row shape the Changes tab draws, so a Chat diff reads like every other diff
 * on the phone.
 */
export function agentChatChangeRows(lines: readonly AgentChatDiffLine[]): DiffLine[] {
    return lines.map((line, index) => ({
        id: String(index),
        kind: line.kind,
        content: line.text,
        oldLine: line.oldLine ?? null,
        newLine: line.newLine ?? null,
        marker: DIFF_MARKER[line.kind],
    }));
}

/**
 * The status letter's color slot for a change kind, matching the letter Desktop paints in the file's `--git-*` color.
 */
export function agentChatChangeColor(
    kind: AgentChatFileChange['kind'],
): 'gitAdded' | 'gitDeleted' | 'gitModified' {
    switch (kind) {
        case 'add': {
            return 'gitAdded';
        }
        case 'delete': {
            return 'gitDeleted';
        }
        case 'update': {
            return 'gitModified';
        }
    }
}

/**
 * The timeline ahead of the projection, as Desktop's pending timeline ends it: answers whose record has not arrived,
 * then messages on their way that start or steer a turn. Each gives way to the real row once the snapshot shows it.
 */
export function withAgentChatPendingEntries(
    entries: readonly AgentChatTimelineEntry[],
    pending: {
        notices: readonly AgentChatItem[];
        timeline: ReadonlyArray<{ id: string; text: string; imageUris: readonly string[] }>;
    },
): readonly AgentChatTimelineEntry[] {
    if (pending.notices.length === 0 && pending.timeline.length === 0) return entries;
    return [
        ...entries,
        ...pending.notices.flatMap((notice): AgentChatTimelineEntry[] =>
            notice.type === 'notice'
                ? [{ kind: 'message', id: `pending:${notice.id}`, message: toMessage(notice) }]
                : [],
        ),
        ...pending.timeline.map((message): AgentChatTimelineEntry => ({
            kind: 'pending',
            id: `pending:${message.id}`,
            text: message.text,
            imageUris: message.imageUris,
        })),
    ];
}
