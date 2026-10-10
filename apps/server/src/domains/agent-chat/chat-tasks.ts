import type { AgentChatTask } from '@caxri/protocol';
import { MAX_AGENT_CHAT_TASKS } from '@caxri/protocol';

import { clip } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';

type TaskFields = Partial<Omit<AgentChatTask, 'id'>>;

const TERMINAL_STATUSES = new Set<AgentChatTask['status']>(['completed', 'failed', 'stopped']);

/**
 * The parent snapshot's `tasks` list, shared by every provider: inserts and merges task fields, bounds every string,
 * keeps the list under {@link MAX_AGENT_CHAT_TASKS} by dropping the oldest ended tasks first, and publishes the whole
 * list as one `state` operation.
 */
export class ChatTaskList {
    constructor(private readonly host: Pick<AgentChatSessionHost, 'apply' | 'read'>) {}

    private publish(tasks: AgentChatTask[]): void {
        this.host.apply([{ op: 'state', state: { tasks } }]);
    }

    get(id: string): AgentChatTask | undefined {
        return this.host.read().tasks?.find((task) => task.id === id);
    }

    /**
     * The task a timeline item started, by the task's `itemId`.
     */
    byItem(itemId: string): AgentChatTask | undefined {
        return this.host.read().tasks?.find((task) => task.itemId === itemId);
    }

    /**
     * Inserts a task, or merges `fields` into the existing one. A new task needs `kind`, `title`, and `status`; missing
     * values default to a running foreground task that cannot be stopped.
     */
    upsert(id: string, fields: TaskFields): AgentChatTask {
        const tasks = [...(this.host.read().tasks ?? [])];
        const index = tasks.findIndex((task) => task.id === id);
        const previous: AgentChatTask = tasks[index] ?? {
            id: clip(id, 200),
            kind: 'agent',
            title: '',
            status: 'running',
            isBackground: false,
            canStop: false,
            startedAt: Date.now(),
        };
        const merged: AgentChatTask = { ...previous, ...definedFields(fields) };
        const task = bounded(merged);
        if (TERMINAL_STATUSES.has(task.status) && task.endedAt === undefined)
            task.endedAt = Date.now();
        if (index === -1) tasks.push(task);
        else tasks[index] = task;
        this.publish(trim(tasks));
        return task;
    }

    /**
     * Marks every running task stopped, for a provider process that ended and took its tasks with it.
     */
    stopAll(): void {
        const tasks = this.host.read().tasks;
        if (!tasks?.some((task) => task.status === 'running')) return;
        const endedAt = Date.now();
        this.publish(
            tasks.map((task) =>
                task.status === 'running'
                    ? { ...task, status: 'stopped' as const, canStop: false, endedAt }
                    : task,
            ),
        );
    }
}

function definedFields(fields: TaskFields): TaskFields {
    return Object.fromEntries(
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- callers spread optional values that may be undefined at runtime
        Object.entries(fields).filter(([, value]) => value !== undefined),
    );
}

function bounded(task: AgentChatTask): AgentChatTask {
    return {
        ...task,
        title: clip(task.title, 1_000),
        ...(task.itemId && { itemId: clip(task.itemId, 200) }),
        ...(task.agentType && { agentType: clip(task.agentType, 200) }),
        ...(task.model && { model: clip(task.model, 200) }),
        ...(task.summary && { summary: clip(task.summary, 2_000) }),
        ...(task.lastToolName && { lastToolName: clip(task.lastToolName, 200) }),
        ...(TERMINAL_STATUSES.has(task.status) && { canStop: false }),
    };
}

function trim(tasks: AgentChatTask[]): AgentChatTask[] {
    let kept = tasks;
    while (kept.length > MAX_AGENT_CHAT_TASKS) {
        const ended = kept.findIndex((task) => TERMINAL_STATUSES.has(task.status));
        kept = kept.toSpliced(ended === -1 ? 0 : ended, 1);
    }
    return kept;
}
