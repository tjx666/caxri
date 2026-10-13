import type {
    CommanderClearData,
    CommanderClearDataResult,
    CommanderDataSummary,
    CommanderTask,
} from '@caxri/protocol';
import { openCommanderTaskStatuses } from '@caxri/protocol';

import type { Translate } from '../../i18n';

/**
 * Which ledger rows a ticked Tasks entry deletes: the finished ones, every one, or those the user picked from the list.
 */
export type CommanderTaskChoice = 'all' | 'chosen' | 'closed';

/**
 * What the Clear Commander Data dialog has ticked. Instructions are implied by Memory, so the dialog shows them ticked
 * and locked while Memory is.
 */
export interface CommanderClearDataSelection {
    tasks: boolean;
    taskChoice: CommanderTaskChoice;
    chosenTaskIds: ReadonlySet<string>;
    taskFiles: boolean;
    inbox: boolean;
    memory: boolean;
    instructions: boolean;
    conversation: boolean;
}

export interface CommanderTaskCounts {
    all: number;
    open: number;
    closed: number;
}

function isOpenCommanderTask(task: Pick<CommanderTask, 'status'>): boolean {
    return openCommanderTaskStatuses.includes(task.status);
}

/**
 * Every open task is listed before any closed one, so counting the listed open tasks is exact; the closed count covers
 * the older closed tasks the list leaves out.
 */
export function commanderTaskCounts(summary: CommanderDataSummary): CommanderTaskCounts {
    const open = summary.tasks.filter(isOpenCommanderTask).length;
    return { all: summary.taskCount, open, closed: Math.max(0, summary.taskCount - open) };
}

/**
 * Opens on the least surprising cleanup, as a browser's Clear Browsing Data does: finished tasks, when there are any.
 * Everything that changes what the Commander knows or is doing waits for an explicit tick. With no finished task the
 * Tasks entry starts on picking from the list, so ticking it never lands on a disabled choice; never on All, which
 * would delete open tasks.
 */
export function defaultCommanderClearDataSelection(
    summary: CommanderDataSummary,
): CommanderClearDataSelection {
    const hasClosedTasks = commanderTaskCounts(summary).closed > 0;
    return {
        tasks: hasClosedTasks,
        taskChoice: hasClosedTasks ? 'closed' : 'chosen',
        chosenTaskIds: new Set(),
        taskFiles: false,
        inbox: false,
        memory: false,
        instructions: false,
        conversation: false,
    };
}

/**
 * The request the selection stands for, or `undefined` when it would clear nothing, which disables the dialog's button.
 */
export function commanderClearDataRequest(
    selection: CommanderClearDataSelection,
    counts: CommanderTaskCounts,
): CommanderClearData | undefined {
    const tasks = selectedTaskScope(selection, counts);
    const request: CommanderClearData = {
        ...(tasks && { tasks }),
        ...(selection.taskFiles && { taskFiles: true }),
        ...(selection.inbox && { inbox: true }),
        ...(selection.memory && { memory: true }),
        ...(selection.instructions && !selection.memory && { instructions: true }),
        ...(selection.conversation && { conversation: true }),
    };
    return Object.keys(request).length === 0 ? undefined : request;
}

function selectedTaskScope(
    selection: CommanderClearDataSelection,
    counts: CommanderTaskCounts,
): CommanderClearData['tasks'] {
    if (!selection.tasks) return undefined;
    if (selection.taskChoice === 'chosen')
        return selection.chosenTaskIds.size > 0 ? [...selection.chosenTaskIds] : undefined;
    if (selection.taskChoice === 'closed') return counts.closed > 0 ? 'closed' : undefined;
    return counts.all > 0 ? 'all' : undefined;
}

/**
 * Resetting memory or instructions changes the files, not the running Agent: what it already read stays in its context
 * until the conversation starts over, so the dialog says so when the user did not also tick a new conversation.
 */
export function isMemoryStillInConversation(
    selection: CommanderClearDataSelection,
    summary: CommanderDataSummary,
): boolean {
    return (
        (selection.memory || selection.instructions) &&
        !selection.conversation &&
        summary.conversation.isBound
    );
}

export function hasLearnedMemory(summary: CommanderDataSummary): boolean {
    return summary.memory.some((file) => !file.isTemplate);
}

/**
 * One sentence naming what went, for the success toast, so the user does not reopen the dialog to check.
 */
export function commanderClearDataOutcome(result: CommanderClearDataResult, t: Translate): string {
    const parts = [
        result.tasksDeleted > 0 &&
            t(
                result.tasksDeleted === 1
                    ? 'agentCommander.clearData.outcome.tasksOne'
                    : 'agentCommander.clearData.outcome.tasks',
                { count: result.tasksDeleted },
            ),
        result.taskFilesDeleted > 0 &&
            t(
                result.taskFilesDeleted === 1
                    ? 'agentCommander.clearData.outcome.filesOne'
                    : 'agentCommander.clearData.outcome.files',
                { count: result.taskFilesDeleted },
            ),
        result.inboxItemsDeleted > 0 &&
            t(
                result.inboxItemsDeleted === 1
                    ? 'agentCommander.clearData.outcome.inboxOne'
                    : 'agentCommander.clearData.outcome.inbox',
                { count: result.inboxItemsDeleted },
            ),
        result.memoryReset && t('agentCommander.clearData.outcome.memory'),
        result.instructionsRewritten &&
            !result.memoryReset &&
            t('agentCommander.clearData.outcome.instructions'),
        result.conversationReset && t('agentCommander.clearData.outcome.conversation'),
    ].filter((part): part is string => typeof part === 'string');
    if (parts.length === 0) return t('agentCommander.clearData.outcome.nothing');
    return t('agentCommander.clearData.outcome.summary', {
        parts: parts.join(t('agentCommander.clearData.outcome.separator')),
    });
}
