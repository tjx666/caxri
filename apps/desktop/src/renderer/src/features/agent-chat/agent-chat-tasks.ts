import type {
    AgentChatItem,
    AgentChatTask,
    AgentChatTaskSnapshot,
    AgentUsageReadout,
} from '@caxri/protocol';
import { formatTokens } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { agentUsageCostLabel } from '../status-bar/agent-usage-label';

/**
 * Tool names whose row starts a subagent, compared without case or separators: Claude Code's `Task` and `Agent`, and
 * Codex's collab `spawnAgent` (also seen as `spawn_agent`).
 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['task', 'agent', 'spawnagent']);

function normalizedToolName(name: string): string {
    return name.toLowerCase().replaceAll(/[^a-z]/gu, '');
}

/**
 * Whether a timeline row started a subagent. Such a row stays openable even when the live task list no longer knows it
 * (a resumed conversation), because `agentChat.readTask` rebuilds a subagent from the item that started it.
 */
export function isAgentChatSubagentItem(item: AgentChatItem): boolean {
    return item.type === 'toolCall' && SUBAGENT_TOOL_NAMES.has(normalizedToolName(item.name));
}

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
 * `683k tokens · $0.21 · 8 tool uses`. `billed` is the subagent's own transcript priced like the status bar
 * (`terminal.agentTaskUsage`); its tokens replace the provider's `totalTokens`, which counts only the latest request's
 * context, so the figure beside the cost is the one the cost was computed from and adds up to the conversation's total.
 * Without it the provider's count is shown and no cost.
 */
export function agentChatTaskUsageSummary(
    task: Pick<AgentChatTask, 'usage'>,
    t: Translate,
    billed?: AgentUsageReadout | null,
): string | undefined {
    const parts: string[] = [];
    const { toolUses } = task.usage ?? {};
    const totalTokens = billed ? billed.tokens.total : task.usage?.totalTokens;
    if (totalTokens)
        parts.push(t('agentChat.tasks.usageTokens', { tokens: formatTokens(totalTokens) }));
    const cost = billed && agentUsageCostLabel(billed);
    if (cost) parts.push(cost);
    if (toolUses)
        parts.push(
            toolUses === 1
                ? t('agentChat.tasks.toolUseOne')
                : t('agentChat.tasks.toolUseOther', { count: toolUses }),
        );
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * `general-purpose · claude-sonnet-4-5`, the facts a subagent tab header shows under its title.
 */
export function agentChatTaskIdentity(
    task: Pick<AgentChatTask, 'agentType' | 'model'> | undefined,
): string | undefined {
    const parts = [task?.agentType, task?.model].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * What a running task is doing now, for its timeline row and strip entry: the provider's progress line, else the tool
 * it last used. An ended task shows its final summary. A component passes its `t` so the label follows a language
 * change; `translate` is only the fallback for callers that have not been given one.
 */
export function agentChatTaskActivity(
    task: Pick<AgentChatTask, 'lastToolName' | 'status' | 'summary'>,
    t: Translate = translate,
): string | undefined {
    const summary = task.summary?.trim();
    if (summary) return summary;
    if (task.status === 'running' && task.lastToolName)
        return t('agentChat.tasks.usingTool', { tool: task.lastToolName });
    return undefined;
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
