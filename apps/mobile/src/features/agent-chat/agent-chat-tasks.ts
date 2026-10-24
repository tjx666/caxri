import type {
    AgentChatActivity,
    AgentChatSnapshot,
    AgentChatTask,
    AgentChatTaskSnapshot,
    AgentChatWorkItem,
} from '@caxri/protocol';
import {
    agentChatTaskElapsedMs,
    agentChatTaskStripView,
    agentChatTaskSummary,
    canStopAgentChatTask,
    formatNoticeableDuration,
    isAgentChatTaskTitleCommand,
    isAgentChatWorkItem,
} from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';

/**
 * How often an open task detail re-reads its output through `mobile.agentChat.readTask` while the task runs. The phone
 * does not subscribe to `agentChat.taskPatch`, so this is the detail's live update.
 */
export const AGENT_CHAT_TASK_POLL_MS = 1_500;

/**
 * What the status row's Background work badge stands for, by Desktop's strip rule (`agentChatTaskStripView`): the
 * running work and every ended task while anything runs, and nothing once the last one ends. `undefined` hides the
 * badge (Grok Build, which reports no tasks, never shows one).
 */
export interface AgentChatTaskPill {
    running: AgentChatTask[];
    ended: AgentChatTask[];
    /**
     * `2 running`, or `2 running · 1 ended`.
     */
    label: string;
}

export function agentChatTaskPill(
    snapshot: Pick<AgentChatSnapshot, 'tasks'> | undefined,
    t: Translate = translate,
): AgentChatTaskPill | undefined {
    const view = agentChatTaskStripView(snapshot?.tasks);
    if (!view) return undefined;
    return { ...view, label: taskCountLabel(view.running, view.ended, t) };
}

function taskCountLabel(
    running: readonly AgentChatTask[],
    ended: readonly AgentChatTask[],
    t: Translate,
): string {
    return [
        ...(running.length > 0 ? [t('chat.tasks.runningCount', { count: running.length })] : []),
        ...(ended.length > 0 ? [t('chat.tasks.endedCount', { count: ended.length })] : []),
    ].join(' · ');
}

/**
 * The ids of the tasks a pill lists, in order, which the open Background work sheet keeps (see
 * `agentChatTaskSheetPill`).
 */
export function agentChatTaskPillIds(pill: AgentChatTaskPill | undefined): string[] {
    return pill ? [...pill.running, ...pill.ended].map((task) => task.id) : [];
}

/**
 * What the open Background work sheet lists: the pill while there is one, else the tasks it last listed
 * (`lastListedIds`), each in its current state. The pill disappears the moment the last task ends, so without this the
 * list a reader just opened emptied to `No background work.` under them.
 */
export function agentChatTaskSheetPill(
    pill: AgentChatTaskPill | undefined,
    lastListedIds: readonly string[],
    tasks: readonly AgentChatTask[] | undefined,
    t: Translate = translate,
): AgentChatTaskPill | undefined {
    if (pill) return pill;
    const current = lastListedIds.flatMap((id) => tasks?.filter((task) => task.id === id) ?? []);
    if (current.length === 0) return undefined;
    const running = current.filter((task) => task.status === 'running');
    const ended = current.filter((task) => task.status !== 'running');
    return {
        running,
        ended,
        label: taskCountLabel(running, ended, t),
    };
}

/**
 * How many tasks of one kind run, for the status row's background work badge.
 */
export interface AgentChatRunningKind {
    kind: AgentChatTask['kind'];
    count: number;
}

const RUNNING_KIND_ORDER: ReadonlyArray<AgentChatTask['kind']> = ['agent', 'shell'];

/**
 * Running tasks counted per kind in a fixed order (subagents, then shells) and only kinds with one running, as
 * Desktop's badge shows them, so the glyphs never swap places as tasks start and end.
 */
export function agentChatRunningKinds(running: readonly AgentChatTask[]): AgentChatRunningKind[] {
    return RUNNING_KIND_ORDER.map((kind) => ({
        kind,
        count: running.filter((task) => task.kind === kind).length,
    })).filter(({ count }) => count > 0);
}

/**
 * What leads the status row once the turn ended but background work still runs, as Desktop's row says it: the one
 * running task by title, or a count of several.
 */
export function agentChatTaskLeadText(pill: AgentChatTaskPill, t: Translate = translate): string {
    return pill.running.length === 1
        ? t('chat.tasks.leadOne', { title: agentChatTaskRow(pill.running[0], 0, t).title })
        : t('chat.tasks.leadMany', { count: pill.running.length });
}

const STATUS_LABELS = {
    running: 'chat.tasks.status.running',
    completed: 'chat.tasks.status.completed',
    failed: 'chat.tasks.status.failed',
    stopped: 'chat.tasks.status.stopped',
} as const satisfies Record<AgentChatTask['status'], TranslationKey>;

/**
 * One task as the phone lists it and titles its detail.
 */
export interface AgentChatTaskRow {
    /**
     * The task's title, or `Background shell` / `Subagent` when the provider gave none.
     */
    title: string;
    /**
     * Whether the title is the command line itself, set in monospace as on Desktop.
     */
    isCommandTitle: boolean;
    statusLabel: string;
    /**
     * `12s` or `3m 4s`; absent under a second or without a start time.
     */
    elapsed: string | undefined;
    /**
     * The provider's progress or final summary line.
     */
    summary: string | undefined;
    /**
     * Whether Stop applies: the task runs and the provider can stop it on its own. A device still needs control access.
     */
    canStop: boolean;
    accessibilityLabel: string;
}

export function agentChatTaskRow(
    task: AgentChatTask,
    now: number,
    t: Translate = translate,
): AgentChatTaskRow {
    const kindLabel = t(
        task.kind === 'shell' ? 'chat.tasks.backgroundShell' : 'chat.tasks.subagent',
    );
    const title = task.title || kindLabel;
    const statusLabel = t(STATUS_LABELS[task.status]);
    const elapsed = formatNoticeableDuration(agentChatTaskElapsedMs(task, now), t) ?? undefined;
    const summary = agentChatTaskSummary(task, statusLabel);
    return {
        title,
        isCommandTitle: isAgentChatTaskTitleCommand(task),
        statusLabel,
        elapsed,
        summary,
        canStop: canStopAgentChatTask(task),
        accessibilityLabel: [kindLabel, title, elapsed ? `${statusLabel}, ${elapsed}` : statusLabel]
            .map((part) => `${part}.`)
            .join(' '),
    };
}

/**
 * Why Stop fails, as the detail says it. A task that already ended is not an error: the next read shows how it ended.
 */
export const agentChatTaskStopError = (t: Translate = translate): string =>
    t('chat.tasks.stopError');
/**
 * The stop request went through but the Chat never reported the task ended.
 */
export const agentChatTaskStopUnconfirmed = (t: Translate = translate): string =>
    t('chat.tasks.stopUnconfirmed');
export const agentChatTaskReadError = (t: Translate = translate): string =>
    t('chat.tasks.readError');

/**
 * One step of a subagent's transcript as the phone lists it: what it said, or a piece of its work drawn like a Chat
 * work row. Its prompt and anything else the parent already shows are left out.
 */
export type AgentChatTaskTranscriptEntry =
    | { kind: 'message'; id: string; text: string }
    | { kind: 'work'; id: string; item: AgentChatWorkItem };

/**
 * What a task's detail shows under its facts: a shell's output tail, or a subagent's transcript in order, which is what
 * Desktop's task tab shows. `notes` say what the phone's copy leaves out or no longer follows.
 */
export type AgentChatTaskDetailContent =
    | { kind: 'output' | 'empty'; text: string; notes: string[] }
    | { kind: 'transcript'; entries: AgentChatTaskTranscriptEntry[]; notes: string[] };

export function agentChatTaskDetailContent(
    task: Pick<AgentChatTask, 'kind' | 'status'>,
    detail: AgentChatTaskSnapshot,
    t: Translate = translate,
): AgentChatTaskDetailContent {
    const isOutput = task.kind === 'shell' || detail.output !== undefined;
    const notes = [
        ...(detail.truncated
            ? [t(isOutput ? 'chat.tasks.earlierOutput' : 'chat.tasks.earlierMessages')]
            : []),
        ...(detail.isOutputCapped && task.status === 'running'
            ? [t('chat.tasks.outputCapped')]
            : []),
    ];
    const isRunning = task.status === 'running';
    if (isOutput) {
        const output = (detail.output ?? '').replace(/\n+$/u, '');
        return output
            ? { kind: 'output', text: output, notes }
            : {
                  kind: 'empty',
                  text: t(isRunning ? 'chat.tasks.noOutputYet' : 'chat.tasks.noOutput'),
                  notes,
              };
    }
    const entries = detail.items.flatMap((item): AgentChatTaskTranscriptEntry[] => {
        if (item.type === 'agentMessage')
            return item.text.trim() === ''
                ? []
                : [{ kind: 'message', id: item.id, text: item.text }];
        return isAgentChatWorkItem(item) ? [{ kind: 'work', id: item.id, item }] : [];
    });
    if (entries.length > 0) return { kind: 'transcript', entries, notes };
    return {
        kind: 'empty',
        text: t(isRunning ? 'chat.tasks.noMessagesYet' : 'chat.tasks.noMessages'),
        notes,
    };
}

/**
 * What the status row above the composer shows, as Desktop's single row lays it out: the turn's activity leads while it
 * runs, with a badge counting the running background work beside it; once the turn ended, the running work itself leads
 * (`agentChatTaskLeadText`). Work that has only ended shows nothing, as on Desktop; its rows in the timeline still open
 * it. Undefined when there is nothing to say.
 */
export function agentChatStatusRow(
    activity: AgentChatActivity | undefined,
    pill: AgentChatTaskPill | undefined,
): { lead: 'activity' | 'tasks'; badge: AgentChatRunningKind[] } | undefined {
    const running = pill?.running ?? [];
    if (activity) return { lead: 'activity', badge: agentChatRunningKinds(running) };
    return running.length > 0 ? { lead: 'tasks', badge: [] } : undefined;
}
