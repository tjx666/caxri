import type {
    AgentChatDelegatedTask,
    AgentChatDiffLine,
    AgentChatFileChange,
    AgentChatItem,
    AgentChatPathReference,
    AgentChatSkillReference,
    AgentChatSnapshot,
    AgentChatTurn,
    AgentChatTurnArtifacts,
    AgentChatTurnFoldSegment,
    AgentChatWorkItem,
    AgentTimelineItem,
} from '@caxri/protocol';
import {
    agentChatFinalReplyId,
    agentChatFoldTiming,
    agentChatNoticeMessage,
    agentChatTurnLabel,
    collectAgentChatTurnArtifacts,
    foldAgentChatTurn,
    isAgentChatAwaitingReply,
    isAgentChatItemVisible,
    isAgentChatSubagentItem,
    isAgentChatWorkItem,
    parseAgentChatPathReferences,
    splitAgentChatWork,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
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
 * (`splitAgentChatWork`): ordinary tools enter the same summary while running and after completion. A finished turn
 * folds its work and commentary behind its `Worked for` row (`turn`) the way Desktop does (`foldAgentChatTurn`), and
 * ends with what it left behind (`artifacts`) under its final reply.
 */
export type AgentChatTimelineEntry =
    | { kind: 'feedback'; id: string; notice: Extract<AgentChatItem, { type: 'notice' }> }
    | {
          kind: 'message';
          id: string;
          message: AgentChatMessageEntry;
          /**
           * The files, folders, and skills a user message cited ahead of its words (`parseAgentChatPathReferences`),
           * drawn as chips under its images; `message.text` is then only what the user typed. Absent when it cited
           * none.
           */
          cited?: { references: AgentChatPathReference[]; skills: AgentChatSkillReference[] };
      }
    | {
          /**
           * An answered question request, listed as each question over the answer given (Desktop's `Asked 3
           * questions`). `isExpanded` starts true, since the answers are what the next reply acts on; the list owns the
           * folded ids.
           */
          kind: 'answered';
          id: string;
          isExpanded: boolean;
          answers: ReadonlyArray<{ question: string; answer: string }>;
      }
    | {
          /**
           * A user message that is really another Agent's delegated task pointer, captioned with who sent it and the
           * pointer folded away, as Desktop draws it.
           */
          kind: 'delegated';
          id: string;
          /**
           * Whether the user unfolded the raw pointer; the list owns it, like a turn's fold.
           */
          isExpanded: boolean;
          text: string;
          task: AgentChatDelegatedTask;
      }
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
          /**
           * The key the list's expanded set holds for this row: the turn id for its first fold, and the turn id with
           * the segment index for each later fold of a turn split by steered messages, so each fold opens on its own.
           */
          foldKey: string;
          label: string;
          status: AgentChatTurn['status'];
          stoppedBy?: AgentChatTurn['stoppedBy'];
          /**
           * Whether the row toggles the turn's folded work, which then follows it as ordinary entries. Absent when the
           * turn had nothing to fold (a prompt and its reply), so the row only says how the turn went.
           */
          fold?: 'collapsed' | 'expanded';
          /**
           * The subagents a collapsed fold hides, in timeline order, so the row can reopen each without being expanded,
           * as Desktop's fold does (issue caxri#1613). A background subagent can outlive its turn.
           */
          subagents?: readonly AgentChatWorkItem[];
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
      }
    | {
          /**
           * The reply's place while the running turn has shown nothing yet (`isAgentChatAwaitingReply`).
           */
          kind: 'awaiting';
          id: string;
      };

const toMessage = (
    item: Extract<AgentChatItem, { type: 'agentMessage' | 'notice' | 'userMessage' }>,
    t: Translate,
): AgentChatMessageEntry => {
    switch (item.type) {
        case 'userMessage': {
            return {
                id: item.id,
                type: item.type,
                text: parseAgentChatPathReferences(item.text).text,
            };
        }
        case 'agentMessage': {
            return {
                id: item.id,
                type: item.type,
                text: item.text,
                ...(item.streaming && { streaming: true }),
            };
        }
        case 'notice': {
            return {
                id: item.id,
                type: 'systemEvent',
                kind: 'caveat',
                summary: agentChatNoticeMessage(item, t).slice(0, 240),
                ...(agentChatNoticeMessage(item, t).length > 240 && {
                    detail: agentChatNoticeMessage(item, t),
                }),
                ...(item.kind === 'error' && { status: 'failed' as const }),
            };
        }
    }
};

/**
 * An `answered` notice that recorded structured answers as a list row; one without them (an older record) stays the
 * plain notice message.
 */
function answeredEntry(item: AgentChatItem): AgentChatTimelineEntry | undefined {
    if (item.type !== 'notice' || item.kind !== 'answered' || !item.answers?.length)
        return undefined;
    return { kind: 'answered', id: item.id, isExpanded: true, answers: item.answers };
}

/**
 * A message row. A user message that cites files, folders, or skills splits them off as `cited`, so the bubble shows
 * only the user's words (Desktop's `AgentChatUserMessage`).
 */
function messageEntry(
    item: Extract<AgentChatItem, { type: 'agentMessage' | 'notice' | 'userMessage' }>,
    t: Translate,
): AgentChatTimelineEntry {
    const base = { kind: 'message' as const, id: item.id, message: toMessage(item, t) };
    if (item.type !== 'userMessage') return base;
    const { references, skills } = parseAgentChatPathReferences(item.text);
    return references.length > 0 || skills.length > 0
        ? { ...base, cited: { references, skills } }
        : base;
}

/**
 * Visible items as entries, consecutive work grouped into one `work` entry.
 */
function groupEntries(
    visible: readonly AgentChatItem[],
    t: Translate,
    taskItemIds: ReadonlySet<string>,
): AgentChatTimelineEntry[] {
    const entries: AgentChatTimelineEntry[] = [];
    let work: AgentChatWorkItem[] = [];
    const flush = (): void => {
        const first = work.at(0);
        if (first)
            entries.push({
                kind: 'work',
                id: `work:${first.id}`,
                ...splitAgentChatWork(work, (item) => taskItemIds.has(item.id)),
            });
        work = [];
    };
    for (const item of visible) {
        if (isAgentChatWorkItem(item)) {
            work.push(item);
            continue;
        }
        flush();
        const answered = answeredEntry(item);
        if (answered) entries.push(answered);
        else if (item.type === 'notice' && (item.title || item.kind === 'warning'))
            entries.push({ kind: 'feedback', id: item.id, notice: item });
        else if (item.type === 'userMessage' && item.delegatedTask)
            entries.push({
                kind: 'delegated',
                id: item.id,
                isExpanded: false,
                text: item.text,
                task: item.delegatedTask,
            });
        else entries.push(messageEntry(item, t));
    }
    flush();
    return entries;
}

/**
 * The single segment of a turn nobody steered, for the row of a turn with nothing to fold.
 */
const WHOLE_TURN: AgentChatTurnFoldSegment = { index: 0, opensTurn: true, closesTurn: true };

/**
 * A finished turn's entries. Collapsed, the turn reads as its prompt, the `Worked for` row, its final reply with the
 * artifacts under it, and its notices; expanded, the folded work follows the row. A turn with nothing to fold still
 * gets the row, just before its reply, so how long it ran and how it ended stay in view.
 */
function finishedTurnEntries(
    visible: readonly AgentChatItem[],
    turn: AgentChatTurn,
    artifacts: AgentChatTurnArtifacts | undefined,
    expandedIds: ReadonlySet<string>,
    t: Translate,
    taskItemIds: ReadonlySet<string>,
): AgentChatTimelineEntry[] {
    const finalReplyId = agentChatFinalReplyId(visible);
    const parts = foldAgentChatTurn(visible, finalReplyId);
    // The runtime lib stops at ES2022, which has no `findLast`.
    const lastFold = parts[parts.map((part) => part.kind).lastIndexOf('fold')];
    const foldKey = (segment: AgentChatTurnFoldSegment): string =>
        segment.index === 0 ? turn.id : `${turn.id}:${segment.index}`;
    /**
     * A turn split by steered messages gets a row per fold, each timed by its own segment; only the last says how the
     * turn ended, as on Desktop.
     */
    const row = (
        fold: 'collapsed' | 'expanded' | undefined,
        segment: AgentChatTurnFoldSegment = WHOLE_TURN,
        hasOutcome = true,
    ): Extract<AgentChatTimelineEntry, { kind: 'turn' }> => {
        const status = hasOutcome ? turn.status : 'completed';
        const stoppedBy = hasOutcome ? turn.stoppedBy : undefined;
        const { durationMs } = agentChatFoldTiming(segment, turn);
        return {
            kind: 'turn',
            id: segment.index === 0 ? `turn:${turn.id}` : `turn:${turn.id}:${segment.index}`,
            turnId: turn.id,
            foldKey: foldKey(segment),
            label: agentChatTurnLabel(
                {
                    status,
                    ...(stoppedBy && { stoppedBy }),
                    ...(durationMs !== undefined && { durationMs }),
                },
                t,
            ),
            status,
            ...(stoppedBy && { stoppedBy }),
            ...(fold && { fold }),
        };
    };
    const artifactsEntry: AgentChatTimelineEntry[] = artifacts
        ? [{ kind: 'artifacts', id: `artifacts:${artifacts.turnId}`, artifacts }]
        : [];
    const hasFold = parts.some((part) => part.kind === 'fold');
    const entries: AgentChatTimelineEntry[] = [];
    for (const part of parts) {
        if (part.kind === 'fold') {
            const isExpanded = expandedIds.has(foldKey(part.segment));
            const subagents = isExpanded
                ? []
                : part.items.filter(
                      (item): item is AgentChatWorkItem =>
                          isAgentChatWorkItem(item) && isAgentChatSubagentItem(item),
                  );
            entries.push({
                ...row(isExpanded ? 'expanded' : 'collapsed', part.segment, part === lastFold),
                ...(subagents.length > 0 && { subagents }),
            });
            if (isExpanded) entries.push(...groupEntries(part.items, t, taskItemIds));
            continue;
        }
        if (!hasFold && part.item.id === finalReplyId) entries.push(row(undefined));
        entries.push(...groupEntries([part.item], t, taskItemIds));
        if (part.item.id === finalReplyId) entries.push(...artifactsEntry);
    }
    if (!hasFold && finalReplyId === undefined) entries.push(row(undefined));
    if (finalReplyId === undefined) entries.push(...artifactsEntry);
    return entries;
}

/**
 * Builds the phone's Chat timeline from the projection. Items arrive in order and each turn's items are contiguous, so
 * a run of items sharing a `turnId` is one turn. Only a finished turn (not running and not the active one) folds and
 * gets artifacts, so a running turn stays live and never claims a result it has not reached. `expandedIds` names the
 * finished turns and delegated task pointers the user unfolded, and the answered question lists the user folded; the
 * list owns it rather than a row, so a recycled row never carries another turn's state. When the window cut older items
 * (`truncated`), the oldest turn may be missing its start, so it shows no artifacts rather than an incomplete summary.
 */
export function buildAgentChatTimeline(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'> &
        Partial<Pick<AgentChatSnapshot, 'truncated' | 'tasks'>>,
    expandedIds: ReadonlySet<string> = new Set(),
    t: Translate = translate,
): AgentChatTimelineEntry[] {
    const { activeTurnId, items, turns } = snapshot;
    const taskItemIds = new Set(
        snapshot.tasks?.flatMap((task) => (task.itemId ? [task.itemId] : [])),
    );
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
                      expandedIds,
                      t,
                      taskItemIds,
                  )
                : groupEntries(visible, t, taskItemIds)),
        );
        start = end;
    }
    return entries.map((entry) =>
        entry.kind === 'delegated' && expandedIds.has(entry.id)
            ? { ...entry, isExpanded: true }
            : entry.kind === 'answered' && expandedIds.has(entry.id)
              ? { ...entry, isExpanded: false }
              : entry,
    );
}

/**
 * The expanded set after the user taps a turn's `Worked for` row or a delegated task's Show instruction.
 */
export function toggleAgentChatExpansion(
    expandedIds: ReadonlySet<string>,
    turnId: string,
): ReadonlySet<string> {
    const next = new Set(expandedIds);
    if (!next.delete(turnId)) next.add(turnId);
    return next;
}

/**
 * The ids of the turns still running: the active turn and any turn the projection marks `running`.
 */
export function agentChatRunningTurnIds(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'turns'>,
): ReadonlySet<string> {
    const running = new Set(
        snapshot.turns.filter((turn) => turn.status === 'running').map((turn) => turn.id),
    );
    if (snapshot.activeTurnId !== undefined) running.add(snapshot.activeTurnId);
    return running;
}

/**
 * The expanded set once turns that were running (`previouslyRunning`) have ended. A reader who was not following the
 * latest output (`isFollowing` false) is reading earlier content, so a turn that ends under them stays open instead of
 * folding the work away mid-read, as Desktop keeps open a row the user opened while the turn ran. A reader following
 * the end sees the turn fold as usual. Returns `expandedIds` itself when nothing changes.
 */
export function holdEndedTurnsOpen(
    expandedIds: ReadonlySet<string>,
    previouslyRunning: ReadonlySet<string>,
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'turns'>,
    isFollowing: boolean,
): ReadonlySet<string> {
    if (isFollowing) return expandedIds;
    const running = agentChatRunningTurnIds(snapshot);
    const ended = snapshot.turns.filter(
        (turn) =>
            previouslyRunning.has(turn.id) && !running.has(turn.id) && !expandedIds.has(turn.id),
    );
    if (ended.length === 0) return expandedIds;
    return new Set([...expandedIds, ...ended.map((turn) => turn.id)]);
}

/**
 * The semantic tone of a finished turn's footer, as Desktop tones its fold row: a failed turn is `danger`, one that
 * stopped without the user asking `warning`, and a completed turn or one the user stopped stays quiet.
 */
export function agentChatTurnTone(
    status: AgentChatTurn['status'],
    stoppedBy?: AgentChatTurn['stoppedBy'],
): 'danger' | 'muted' | 'warning' {
    if (status === 'failed') return 'danger';
    return status === 'interrupted' && stoppedBy !== 'user' ? 'warning' : 'muted';
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
    t: Translate = translate,
): readonly AgentChatTimelineEntry[] {
    if (pending.notices.length === 0 && pending.timeline.length === 0) return entries;
    return [
        ...entries,
        ...pending.notices.flatMap((notice): AgentChatTimelineEntry[] =>
            notice.type === 'notice'
                ? [
                      answeredEntry({ ...notice, id: `pending:${notice.id}` }) ?? {
                          kind: 'message',
                          id: `pending:${notice.id}`,
                          message: toMessage(notice, t),
                      },
                  ]
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

/**
 * `entries` with the reply placeholder after the user's message while the running turn has shown nothing yet (a
 * delegated task is the user's message too). Messages still on their way follow it, as on Desktop.
 */
export function withAgentChatAwaitingReply(
    entries: readonly AgentChatTimelineEntry[],
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'operation' | 'requests'> | undefined,
): readonly AgentChatTimelineEntry[] {
    const last = entries.at(-1);
    const isAfterUserMessage =
        last?.kind === 'delegated' ||
        (last?.kind === 'message' && last.message.type === 'userMessage');
    return isAgentChatAwaitingReply(snapshot, isAfterUserMessage)
        ? [...entries, { kind: 'awaiting', id: 'awaiting-reply' }]
        : entries;
}

/**
 * Whether a row starts a turn: the user's message, a delegated task, or a message still on its way. The list keeps the
 * latest one at the top of the viewport at its end, as Desktop's Chat rests a sent message.
 */
export function isAgentChatTurnStart(entry: AgentChatTimelineEntry): boolean {
    return (
        entry.kind === 'pending' ||
        entry.kind === 'delegated' ||
        (entry.kind === 'message' && entry.message.type === 'userMessage')
    );
}
