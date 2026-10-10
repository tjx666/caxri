import type {
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatTask,
    AgentChatTaskSnapshot,
} from '@caxri/protocol';
import { formatShortDuration, formatTokens } from '@caxri/protocol';

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
 * The Chat's tasks keyed by the timeline item that started each one, so a row finds its task in constant time.
 */
export function agentChatTasksByItem(
    tasks: readonly AgentChatTask[] | undefined,
): ReadonlyMap<string, AgentChatTask> {
    const listed = tasks ?? [];
    const byItem = new Map<string, AgentChatTask>();
    for (const task of listed) if (task.itemId) byItem.set(task.itemId, task);
    return byItem;
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
 * The Chat's task with this key, matched by its own id or by the item that started it (the two keys a task tab path may
 * carry).
 */
export function findAgentChatTask(
    tasks: readonly AgentChatTask[] | undefined,
    taskId: string,
): AgentChatTask | undefined {
    return (
        tasks?.find((task) => task.id === taskId) ?? tasks?.find((task) => task.itemId === taskId)
    );
}

/**
 * How long a task has run, or ran. A running task counts up from its start; an ended one prefers the provider's own
 * duration over the wall clock between start and end.
 */
export function agentChatTaskElapsedMs(
    task: Pick<AgentChatTask, 'endedAt' | 'startedAt' | 'status' | 'usage'>,
    now: number,
): number | undefined {
    if (task.status !== 'running' && task.usage?.durationMs !== undefined)
        return task.usage.durationMs;
    if (task.startedAt === undefined) return undefined;
    const end = task.status === 'running' ? now : (task.endedAt ?? now);
    return Math.max(0, end - task.startedAt);
}

/**
 * `12s`, or nothing below a second, which would read `<1s` and jump straight to `1s`.
 */
export function formatAgentChatTaskElapsed(elapsedMs: number | undefined): string | undefined {
    if (elapsedMs === undefined || elapsedMs < 1000) return undefined;
    return formatShortDuration(elapsedMs) ?? undefined;
}

/**
 * `12.3k tokens · 8 tool uses`, from whatever usage the provider reported.
 */
export function agentChatTaskUsageSummary(task: Pick<AgentChatTask, 'usage'>): string | undefined {
    const parts: string[] = [];
    const { totalTokens, toolUses } = task.usage ?? {};
    if (totalTokens) parts.push(`${formatTokens(totalTokens)} tokens`);
    if (toolUses) parts.push(toolUses === 1 ? '1 tool use' : `${toolUses} tool uses`);
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
 * The item status whose glyph shows a task's status. A stopped task reads like an interrupted item.
 */
export function agentChatTaskGlyphStatus(status: AgentChatTask['status']): AgentChatItemStatus {
    return status === 'stopped' ? 'interrupted' : status;
}

/**
 * What a running task is doing now, for its timeline row and strip entry: the provider's progress line, else the tool
 * it last used. An ended task shows its final summary.
 */
export function agentChatTaskActivity(
    task: Pick<AgentChatTask, 'lastToolName' | 'status' | 'summary'>,
): string | undefined {
    const summary = task.summary?.trim();
    if (summary) return summary;
    if (task.status === 'running' && task.lastToolName) return `Using ${task.lastToolName}`;
    return undefined;
}

/**
 * Whether a task's title is a shell command line, set in monospace. A shell the Agent described is titled in words, and
 * its command line moves into the task tab.
 */
export function isAgentChatTaskTitleCommand(
    task: Pick<AgentChatTask, 'command' | 'kind'> | undefined,
    kind: AgentChatTask['kind'] = task?.kind ?? 'agent',
): boolean {
    return kind === 'shell' && !task?.command;
}

export function canStopAgentChatTask(task: Pick<AgentChatTask, 'canStop' | 'status'>): boolean {
    return task.canStop && task.status === 'running';
}

/**
 * The background work strip above the composer: running tasks in start order, and how many have ended.
 */
export function agentChatTaskStrip(tasks: readonly AgentChatTask[] | undefined): {
    running: AgentChatTask[];
    endedCount: number;
} {
    const listed = tasks ?? [];
    const running = listed
        .filter((task) => task.status === 'running')
        .toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return { running, endedCount: listed.length - running.length };
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
