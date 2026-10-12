import type {
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatTask,
    AgentChatTaskSnapshot,
} from '@caxri/protocol';
import { formatTokens } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

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
 * `12.3k tokens · 8 tool uses`, from whatever usage the provider reported.
 */
export function agentChatTaskUsageSummary(
    task: Pick<AgentChatTask, 'usage'>,
    t: Translate,
): string | undefined {
    const parts: string[] = [];
    const { totalTokens, toolUses } = task.usage ?? {};
    if (totalTokens)
        parts.push(t('agentChat.tasks.usageTokens', { tokens: formatTokens(totalTokens) }));
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
 * The item status whose glyph shows a task's status. A stopped task reads like an interrupted item.
 */
export function agentChatTaskGlyphStatus(status: AgentChatTask['status']): AgentChatItemStatus {
    return status === 'stopped' ? 'interrupted' : status;
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
 * The background work strip above the composer: running tasks in start order, and the ended ones most recent first, so
 * the strip can reveal what just finished.
 */
export function agentChatTaskStrip(tasks: readonly AgentChatTask[] | undefined): {
    running: AgentChatTask[];
    ended: AgentChatTask[];
} {
    const listed = tasks ?? [];
    const running = listed
        .filter((task) => task.status === 'running')
        .toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const ended = listed
        .filter((task) => task.status !== 'running')
        .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return { running, ended };
}

/**
 * What the background work strip shows. While anything runs, it lists the running work and counts every ended task.
 * Once the last task ends, the strip stays as a collapsed `N ended` row for the work that ended since the latest turn
 * started, so a task that just finished does not vanish before the user sees how it ended; the next turn starting, or
 * the row's dismiss button (`dismissedAt`, the newest end time the user dismissed), clears it. A task without an end
 * time cannot be placed against the turn, so it never keeps an idle strip open.
 */
export function agentChatTaskStripView(
    tasks: readonly AgentChatTask[] | undefined,
    {
        dismissedAt,
        latestTurnStartedAt,
    }: { dismissedAt: number | undefined; latestTurnStartedAt: number | undefined },
): { running: AgentChatTask[]; ended: AgentChatTask[]; isDismissible: boolean } | undefined {
    const { running, ended } = agentChatTaskStrip(tasks);
    if (running.length > 0) return { running, ended, isDismissible: false };
    if (latestTurnStartedAt === undefined) return undefined;
    const recent = ended.filter(
        (task) =>
            task.endedAt !== undefined &&
            task.endedAt >= latestTurnStartedAt &&
            (dismissedAt === undefined || task.endedAt > dismissedAt),
    );
    return recent.length > 0 ? { running, ended: recent, isDismissible: true } : undefined;
}

/**
 * The newest end time among `tasks`, which dismissing the idle strip records so only work ending later reopens it.
 */
export function agentChatTasksLatestEnd(tasks: readonly AgentChatTask[]): number | undefined {
    let latest: number | undefined;
    for (const task of tasks)
        if (task.endedAt !== undefined && (latest === undefined || task.endedAt > latest))
            latest = task.endedAt;
    return latest;
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
