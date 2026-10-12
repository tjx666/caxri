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
    agentChatNoticeMessage,
    agentChatTurnLabel,
    collectAgentChatTurnArtifacts,
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
 * own live rows. A finished turn ends with what it left behind (`artifacts`) and its `Worked for` footer.
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
    | { kind: 'turn'; id: string; label: string; status: AgentChatTurn['status'] };

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
 * The turn's final reply. A loop rather than `findLast`, which the phone's ES2022 runtime library does not declare.
 */
function lastReplyId(items: readonly AgentChatItem[]): string | undefined {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.type === 'agentMessage') return item.id;
    }
    return undefined;
}

/**
 * One turn's entries, with the turn's artifacts right after its final reply (or at its end when it ended without one).
 */
function turnEntries(
    segment: readonly AgentChatItem[],
    artifacts: AgentChatTurnArtifacts | undefined,
): AgentChatTimelineEntry[] {
    const visible = segment.filter((item) => isAgentChatItemVisible(item));
    const finalReplyId = artifacts ? lastReplyId(visible) : undefined;
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
        if (artifacts && item.id === finalReplyId)
            entries.push({ kind: 'artifacts', id: `artifacts:${artifacts.turnId}`, artifacts });
    }
    flush();
    if (artifacts && finalReplyId === undefined)
        entries.push({ kind: 'artifacts', id: `artifacts:${artifacts.turnId}`, artifacts });
    return entries;
}

/**
 * Builds the phone's Chat timeline from the projection. Items arrive in order and each turn's items are contiguous, so
 * a run of items sharing a `turnId` is one turn. Only a finished turn (not running and not the active one) gets
 * artifacts and a footer, so a running turn never claims a result it has not reached.
 */
export function buildAgentChatTimeline(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'>,
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
        const turn = turnId === undefined ? undefined : finished.get(turnId);
        entries.push(
            ...turnEntries(
                segment,
                turn ? collectAgentChatTurnArtifacts(turn.id, segment) : undefined,
            ),
        );
        if (turn)
            entries.push({
                kind: 'turn',
                id: `turn:${turn.id}`,
                label: agentChatTurnLabel(turn),
                status: turn.status,
            });
        start = end;
    }
    return entries;
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
