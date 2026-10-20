import type {
    AgentChatHistoryPage,
    AgentChatTask,
    AgentChatTaskPatch,
    AgentChatTaskPatchOperation,
    AgentChatTaskSnapshot,
} from '@caxri/protocol';
import {
    applyAgentChatTaskOperation,
    emptyAgentChatTaskSnapshot,
    MAX_AGENT_CHAT_PATCH_OPERATIONS,
} from '@caxri/protocol';

import { ChatHistoryArchive, TASK_ARCHIVE_LIMITS } from './chat-history-archive';
import type { ChatTaskHistory } from './chat-provider';

/**
 * Task projections one Chat keeps in memory. Ended tasks are evicted first; an evicted task is rebuilt from the
 * provider's own record when its tab reads it again.
 */
const MAX_TASK_PROJECTIONS = 20;

interface TaskState {
    snapshot: AgentChatTaskSnapshot;
    /**
     * Operations Clients have not seen yet; `snapshot.revision` advances only when they are flushed.
     */
    queued: AgentChatTaskPatchOperation[];
    /**
     * Items the task's budget evicted, which `agentChat.readHistory` pages through for the task's tab.
     */
    archive: ChatHistoryArchive;
}

/**
 * One Chat's task projections (subagent conversations, background shell output), each with its own revisions, patched
 * through `agentChat.taskPatch` the way the parent projection is patched through `agentChat.patch`. The revision floors
 * are shared by every Chat, keyed by {@link taskRevisionKey}, so a task rebuilt after eviction or restart continues past
 * the revision Clients already hold and they re-read instead of discarding new patches as already applied.
 */
export class ChatTaskProjections {
    private readonly tasks = new Map<string, TaskState>();

    constructor(
        private readonly terminalId: string,
        private readonly revisionFloors: Map<string, number>,
        private readonly listed: () => readonly AgentChatTask[],
        private readonly send: (patch: AgentChatTaskPatch) => void,
    ) {}

    private create(taskId: string): TaskState {
        const task: TaskState = {
            snapshot: {
                ...emptyAgentChatTaskSnapshot(this.terminalId, taskId),
                revision: this.revisionFloors.get(taskRevisionKey(this.terminalId, taskId)) ?? 0,
            },
            queued: [],
            archive: new ChatHistoryArchive(TASK_ARCHIVE_LIMITS),
        };
        this.tasks.set(taskId, task);
        this.evict();
        return task;
    }

    private evict(): void {
        while (this.tasks.size > MAX_TASK_PROJECTIONS) {
            const running = new Set(
                this.listed()
                    .filter((task) => task.status === 'running')
                    .map((task) => task.id),
            );
            const victim =
                this.tasks.keys().find((taskId) => !running.has(taskId)) ??
                this.tasks.keys().next().value;
            if (victim === undefined) return;
            this.retireOne(victim);
        }
    }

    private retireOne(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (!task) return;
        this.flushOne(taskId, task);
        this.revisionFloors.set(
            taskRevisionKey(this.terminalId, taskId),
            task.snapshot.revision + 1,
        );
        this.tasks.delete(taskId);
    }

    private flushOne(taskId: string, task: TaskState): void {
        while (task.queued.length > 0) {
            const operations = task.queued.splice(0, MAX_AGENT_CHAT_PATCH_OPERATIONS);
            const baseRevision = task.snapshot.revision;
            task.snapshot = { ...task.snapshot, revision: baseRevision + 1 };
            this.send({
                terminalId: this.terminalId,
                taskId,
                baseRevision,
                revision: baseRevision + 1,
                operations,
            });
        }
    }

    /**
     * Operations waiting for the next flush, so the service can flush early once a patch would be full.
     */
    get pendingCount(): number {
        return this.tasks.values().reduce((total, task) => total + task.queued.length, 0);
    }

    get(taskId: string): AgentChatTaskSnapshot | undefined {
        return this.tasks.get(taskId)?.snapshot;
    }

    /**
     * A live projection by task id, or by the id of the timeline item that started the task.
     */
    resolve(taskId: string): AgentChatTaskSnapshot | undefined {
        const direct = this.tasks.get(taskId);
        if (direct) return direct.snapshot;
        const listed = this.listed().find((task) => task.itemId === taskId);
        return listed ? this.tasks.get(listed.id)?.snapshot : undefined;
    }

    apply(taskId: string, operations: readonly AgentChatTaskPatchOperation[]): void {
        if (operations.length === 0) return;
        const task = this.tasks.get(taskId) ?? this.create(taskId);
        for (const operation of operations) applyOperation(task, operation);
        task.queued.push(...operations);
    }

    /**
     * Builds a projection from provider history without publishing it: no Client holds this task yet.
     */
    install(history: ChatTaskHistory): AgentChatTaskSnapshot {
        const existing = this.tasks.get(history.taskId);
        if (existing) return existing.snapshot;
        const task = this.create(history.taskId);
        for (const operation of history.operations) applyOperation(task, operation);
        return task.snapshot;
    }

    /**
     * The page of a live task's history right before `beforeItemId`: the archived items first. Past them the provider
     * keeps nothing Caxri can page, so a task whose provider reported a cut-off record ends `truncated`. `undefined`
     * when no projection exists for `taskId`.
     */
    readHistoryPage(taskId: string, beforeItemId: string): AgentChatHistoryPage | undefined {
        const task = this.tasks.get(taskId);
        if (!task) return undefined;
        this.flushOne(taskId, task);
        const { archive, snapshot } = task;
        const page = archive.page(beforeItemId, snapshot.items[0]?.id);
        if (page && page.items.length > 0)
            return {
                historyId: taskId,
                items: page.items,
                turns: [],
                hasMore: page.hasMore || archive.isIncomplete,
                truncated: false,
            };
        return {
            historyId: taskId,
            items: [],
            turns: [],
            hasMore: false,
            truncated: page !== undefined && archive.isIncomplete,
        };
    }

    flush(): void {
        for (const [taskId, task] of this.tasks) this.flushOne(taskId, task);
    }

    /**
     * Drops every projection, without publishing pending operations, and records where each task's next projection
     * starts.
     */
    retire(): void {
        for (const [taskId, task] of this.tasks)
            this.revisionFloors.set(
                taskRevisionKey(this.terminalId, taskId),
                task.snapshot.revision + 1,
            );
        this.tasks.clear();
    }
}

/**
 * Applies one operation to a task and archives what its budget evicted. A `reset` forgets the archive with the items; a
 * provider that reports its record as cut off (`truncated`) marks the archive incomplete, because items older than the
 * archive's first exist and are not recoverable.
 */
function applyOperation(task: TaskState, operation: AgentChatTaskPatchOperation): void {
    const before = task.snapshot;
    task.snapshot = applyAgentChatTaskOperation(before, operation);
    if (operation.op === 'reset') task.archive.clear();
    else task.archive.recordEviction(before, task.snapshot);
    if (operation.op === 'state' && operation.state.truncated) task.archive.isIncomplete = true;
}

function taskRevisionKey(terminalId: string, taskId: string): string {
    return `${terminalId}\0${taskId}`;
}

/**
 * Drops a closed Chat's task revision floors. A restart keeps them so a rebuilt task continues past what a client
 * holds; a closed Chat's task tabs close with it.
 */
export function forgetTaskRevisions(floors: Map<string, number>, terminalId: string): void {
    const prefix = taskRevisionKey(terminalId, '');
    for (const key of floors.keys()) if (key.startsWith(prefix)) floors.delete(key);
}
