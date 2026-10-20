import { formatTokens } from '../domain/usage-format.js';
import type { AgentChatItemStatus, AgentChatTask } from './agent-chat-contract.js';
import type { AgentChatLabelTranslate } from './agent-chat-labels.js';
import { translateAgentChatLabel } from './agent-chat-labels.js';

/**
 * Presentation rules for a Chat's background work (`snapshot.tasks`) that Desktop's strip and task tab and the phone's
 * Background work sheet share, so both list, time, and offer Stop for the same tasks the same way. Shared wording comes
 * from the `agentChatLabelsEn` catalog; the rest stays with each client.
 */

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
 * The item status whose glyph shows a task's status. A stopped task reads like an interrupted item.
 */
export function agentChatTaskGlyphStatus(status: AgentChatTask['status']): AgentChatItemStatus {
    return status === 'stopped' ? 'interrupted' : status;
}

/**
 * Whether a task's title is a shell command line, set in monospace. A shell the Agent described is titled in words, and
 * its command line moves into the task's detail.
 */
export function isAgentChatTaskTitleCommand(
    task: Pick<AgentChatTask, 'command' | 'kind'> | undefined,
    kind: AgentChatTask['kind'] = task?.kind ?? 'agent',
): boolean {
    return kind === 'shell' && !task?.command;
}

/**
 * `general-purpose · claude-sonnet-4-5`, the facts a subagent's detail shows under its title.
 */
export function agentChatTaskIdentity(
    task: Pick<AgentChatTask, 'agentType' | 'model'> | undefined,
): string | undefined {
    const parts = [task?.agentType, task?.model].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * The provider's progress or final summary line, or `undefined` when it is blank or only restates how the task ended
 * (`Stopped` beside a stopped status), which the status glyph and label already say.
 */
export function agentChatTaskSummary(
    task: Pick<AgentChatTask, 'status' | 'summary'>,
    statusLabel?: string,
): string | undefined {
    const summary = task.summary?.trim();
    if (!summary) return undefined;
    const restated = summary.toLowerCase();
    return restated === task.status || restated === statusLabel?.toLowerCase()
        ? undefined
        : summary;
}

/**
 * What a running task is doing now, for its timeline row and strip entry: the provider's progress line, else the tool
 * it last used. An ended task shows its final summary.
 */
export function agentChatTaskActivity(
    task: Pick<AgentChatTask, 'lastToolName' | 'status' | 'summary'>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string | undefined {
    const summary = agentChatTaskSummary(task);
    if (summary) return summary;
    if (task.status === 'running' && task.lastToolName)
        return t('agentChat.tasks.usingTool', { tool: task.lastToolName });
    return undefined;
}

/**
 * `683k tokens · $0.21 · 8 tool uses`. Without `billed` the provider's `totalTokens` is shown and no cost; Desktop
 * passes the subagent transcript priced like its status bar, whose tokens replace the provider's count so the figure
 * beside the cost is the one the cost was computed from.
 */
export function agentChatTaskUsageSummary(
    task: Pick<AgentChatTask, 'usage'>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
    billed?: { totalTokens: number; cost: string | undefined },
): string | undefined {
    const parts: string[] = [];
    const { toolUses } = task.usage ?? {};
    const totalTokens = billed ? billed.totalTokens : task.usage?.totalTokens;
    if (totalTokens)
        parts.push(t('agentChat.tasks.usageTokens', { tokens: formatTokens(totalTokens) }));
    if (billed?.cost) parts.push(billed.cost);
    if (toolUses)
        parts.push(
            toolUses === 1
                ? t('agentChat.tasks.toolUseOne')
                : t('agentChat.tasks.toolUseOther', { count: toolUses }),
        );
    return parts.length > 0 ? parts.join(' · ') : undefined;
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
    // `filter` already copies, and the phone's Hermes runtime lacks ES2023 `toSorted`, so the copies sort in place.
    const running = listed
        .filter((task) => task.status === 'running')
        // eslint-disable-next-line unicorn/no-array-sort -- Sorts the fresh copy `filter` returned; see above.
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const ended = listed
        .filter((task) => task.status !== 'running')
        // eslint-disable-next-line unicorn/no-array-sort -- Sorts the fresh copy `filter` returned; see above.
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
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
