import type {
    AgentChatItem,
    AgentChatTask,
    AgentChatTaskSnapshot,
    AgentUsageReadout,
} from '@caxri/protocol';
import { isAgentChatSubagentItem } from '@caxri/protocol';

import { agentUsageCostLabel } from '../status-bar/agent-usage-label';

/**
 * Whether a work row's subagent or background shell still runs, which keeps the row out of a `Ran N commands` summary
 * even after its own tool call returned.
 */
export function isAgentChatTaskItemRunning(
    tasksByItem: ReadonlyMap<string, AgentChatTask> | undefined,
    item: AgentChatItem,
): boolean {
    return tasksByItem?.get(item.id)?.status === 'running';
}

/**
 * What a timeline row opens: the task it started, or, for a subagent row the task list no longer knows, the row's own
 * id as the task key.
 */
export interface AgentChatTaskLink {
    taskId: string;
    task: AgentChatTask | undefined;
}

export function agentChatTaskLinkForItem(
    item: AgentChatItem,
    tasksByItem: ReadonlyMap<string, AgentChatTask>,
): AgentChatTaskLink | undefined {
    const task = tasksByItem.get(item.id);
    if (task) return { taskId: task.id, task };
    if (isAgentChatSubagentItem(item)) return { taskId: item.id, task: undefined };
    return undefined;
}

/**
 * A subagent a finished turn started, which the turn's `Worked for` row opens directly (issue caxri#1613). `title` is
 * unset for a subagent the live task list no longer knows (a resumed conversation).
 */
export interface AgentChatTurnSubagent {
    taskId: string;
    /**
     * The timeline row that started the subagent, which the turn's row reveals where it cannot open the task.
     */
    itemId: string;
    title: string | undefined;
    /**
     * Whether the subagent still runs after its turn ended, so the turn's row can say so without being expanded.
     */
    isRunning: boolean;
}

/**
 * The subagents among a turn's items, in timeline order and once each, so a finished turn can reopen them without its
 * fold being expanded. A background shell is left out: it outlives its turn in the Background work strip.
 */
export function agentChatTurnSubagents(
    items: Iterable<AgentChatItem>,
    tasksByItem: ReadonlyMap<string, AgentChatTask>,
): AgentChatTurnSubagent[] {
    const subagents = new Map<string, AgentChatTurnSubagent>();
    for (const item of items) {
        const link = agentChatTaskLinkForItem(item, tasksByItem);
        if (!link || link.task?.kind === 'shell' || subagents.has(link.taskId)) continue;
        const title = link.task?.title;
        subagents.set(link.taskId, {
            taskId: link.taskId,
            itemId: item.id,
            title: title === '' ? undefined : title,
            isRunning: link.task?.status === 'running',
        });
    }
    return subagents.values().toArray();
}

/**
 * A subagent's own transcript priced like the status bar (`terminal.agentTaskUsage`), in the shape
 * `agentChatTaskUsageSummary` shows beside the provider's tool count. Absent until the read answers.
 */
export function agentChatTaskBilledUsage(
    billed: AgentUsageReadout | null | undefined,
): { totalTokens: number; cost: string | undefined } | undefined {
    return billed
        ? { totalTokens: billed.tokens.total, cost: agentUsageCostLabel(billed) }
        : undefined;
}

/**
 * What kind of work a task tab shows. The Chat's task list says so; a task it no longer lists (a tab restored after a
 * restart) is a shell when its projection carries output and no conversation, and a subagent otherwise.
 */
export function agentChatTaskKind(
    task: Pick<AgentChatTask, 'kind'> | undefined,
    projection: Pick<AgentChatTaskSnapshot, 'items' | 'output'> | undefined,
): AgentChatTask['kind'] {
    if (task) return task.kind;
    return projection?.output !== undefined && projection.items.length === 0 ? 'shell' : 'agent';
}
