import type { AgentChatItemStatus, AgentChatTask } from './agent-chat-contract.js';

/**
 * Presentation rules for a Chat's background work (`snapshot.tasks`) that Desktop's strip and task tab and the phone's
 * Background work sheet share, so both list, time, and offer Stop for the same tasks the same way. Wording that needs a
 * translation stays with each client.
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
 * A provider-paused task is still live: it can resume, accept Stop, and retain its output projection.
 */
export function isAgentChatTaskActive(
    status: AgentChatTask['status'] | undefined,
): status is 'running' | 'waiting' {
    return status === 'running' || status === 'waiting';
}

/**
 * How long a task has run, or ran. A running task counts up from its start; an ended one prefers the provider's own
 * duration over the wall clock between start and end.
 */
export function agentChatTaskElapsedMs(
    task: Pick<AgentChatTask, 'endedAt' | 'startedAt' | 'status' | 'usage'>,
    now: number,
): number | undefined {
    if (!isAgentChatTaskActive(task.status) && task.usage?.durationMs !== undefined)
        return task.usage.durationMs;
    if (task.startedAt === undefined) return undefined;
    const end = isAgentChatTaskActive(task.status) ? now : (task.endedAt ?? now);
    return Math.max(0, end - task.startedAt);
}

/**
 * The item status whose glyph shows a task's status. A stopped task reads like an interrupted item.
 */
export function agentChatTaskGlyphStatus(status: AgentChatTask['status']): AgentChatItemStatus {
    return status === 'stopped' ? 'interrupted' : status === 'waiting' ? 'running' : status;
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

export function canStopAgentChatTask(task: Pick<AgentChatTask, 'canStop' | 'status'>): boolean {
    return task.canStop && isAgentChatTaskActive(task.status);
}

/**
 * The background work strip above the composer: running tasks in start order, and the ended ones most recent first, so
 * the strip can reveal what just finished.
 */
export function agentChatTaskStrip(tasks: readonly AgentChatTask[] | undefined): {
    active: AgentChatTask[];
    ended: AgentChatTask[];
} {
    const listed = tasks ?? [];
    // `filter` already copies, and the phone's Hermes runtime lacks ES2023 `toSorted`, so the copies sort in place.
    const active = listed
        .filter((task) => isAgentChatTaskActive(task.status))
        // eslint-disable-next-line unicorn/no-array-sort -- Sorts the fresh copy `filter` returned; see above.
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const ended = listed
        .filter((task) => !isAgentChatTaskActive(task.status))
        // eslint-disable-next-line unicorn/no-array-sort -- Sorts the fresh copy `filter` returned; see above.
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return { active, ended };
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
): { active: AgentChatTask[]; ended: AgentChatTask[]; isDismissible: boolean } | undefined {
    const { active, ended } = agentChatTaskStrip(tasks);
    if (active.length > 0) return { active, ended, isDismissible: false };
    if (latestTurnStartedAt === undefined) return undefined;
    const recent = ended.filter(
        (task) =>
            task.endedAt !== undefined &&
            task.endedAt >= latestTurnStartedAt &&
            (dismissedAt === undefined || task.endedAt > dismissedAt),
    );
    return recent.length > 0 ? { active, ended: recent, isDismissible: true } : undefined;
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
