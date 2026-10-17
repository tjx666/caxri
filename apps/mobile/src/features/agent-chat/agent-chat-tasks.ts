import type { AgentChatSnapshot, AgentChatTask, AgentChatTaskSnapshot } from '@caxri/protocol';
import {
    agentChatTaskElapsedMs,
    agentChatTaskGlyphStatus,
    agentChatTaskStripView,
    canStopAgentChatTask,
    formatAgentChatFinishedDuration,
    isAgentChatTaskActive,
    isAgentChatTaskTitleCommand,
} from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';

/**
 * How often an open task detail re-reads its output through `mobile.agentChat.readTask` while the task runs. The phone
 * does not subscribe to `agentChat.taskPatch`, so this is the detail's live update.
 */
export const AGENT_CHAT_TASK_POLL_MS = 1_500;

/**
 * What the Background work pill above the phone's composer shows, by Desktop's strip rule (`agentChatTaskStripView`):
 * the running work and every ended task while anything runs, and once the last one ends the work that ended during the
 * latest turn, until the next turn starts or the user dismisses it. `undefined` hides the pill (Grok Build, which
 * reports no tasks, never shows one).
 */
export interface AgentChatTaskPill {
    active: AgentChatTask[];
    ended: AgentChatTask[];
    isDismissible: boolean;
    /**
     * `2 active · 1 ended`, or `3 ended` once nothing runs.
     */
    label: string;
}

export function agentChatTaskPill(
    snapshot: Pick<AgentChatSnapshot, 'tasks' | 'turns'> | undefined,
    dismissedAt: number | undefined,
    t: Translate = translate,
): AgentChatTaskPill | undefined {
    const view = agentChatTaskStripView(snapshot?.tasks, {
        dismissedAt,
        latestTurnStartedAt: snapshot?.turns.at(-1)?.startedAt,
    });
    if (!view) return undefined;
    const parts = [
        ...(view.active.length > 0
            ? [t('chat.tasks.activeCount', { count: view.active.length })]
            : []),
        ...(view.ended.length > 0
            ? [t('chat.tasks.endedCount', { count: view.ended.length })]
            : []),
    ];
    return { ...view, label: parts.join(' · ') };
}

const STATUS_LABELS = {
    running: 'chat.tasks.status.running',
    waiting: 'chat.tasks.status.waiting',
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
    const elapsed =
        formatAgentChatFinishedDuration(
            agentChatTaskElapsedMs(task, now),
            agentChatTaskGlyphStatus(task.status),
            t,
        ) ?? undefined;
    // An all-whitespace summary is no summary.
    const summary = task.summary?.trim() ? task.summary.trim() : undefined;
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
export const agentChatTaskReadError = (t: Translate = translate): string =>
    t('chat.tasks.readError');

/**
 * What a task's detail shows under its facts: a shell's output tail, or a subagent's latest message, which is what
 * Desktop's task tab ends on. `notes` say what the phone's copy leaves out or no longer follows.
 */
export interface AgentChatTaskDetailContent {
    kind: 'output' | 'message' | 'empty';
    text: string;
    notes: string[];
}

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
        ...(detail.isOutputCapped && isAgentChatTaskActive(task.status)
            ? [t('chat.tasks.outputCapped')]
            : []),
    ];
    const isRunning = isAgentChatTaskActive(task.status);
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
    // The phone's Hermes runtime lacks ES2023 `findLast`.
    for (let index = detail.items.length - 1; index >= 0; index -= 1) {
        const item = detail.items[index];
        if (item.type === 'agentMessage' && item.text.trim() !== '')
            return { kind: 'message', text: item.text, notes };
    }
    return {
        kind: 'empty',
        text: t(isRunning ? 'chat.tasks.noMessagesYet' : 'chat.tasks.noMessages'),
        notes,
    };
}
