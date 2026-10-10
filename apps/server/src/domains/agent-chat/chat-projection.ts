import type {
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTask,
    AgentChatTaskPatchOperation,
    ServerEvent,
} from '@caxri/protocol';
import {
    applyAgentChatOperation,
    emptyAgentChatSnapshot,
    MAX_AGENT_CHAT_PATCH_OPERATIONS,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { ChatTaskProjections } from './chat-task-projections';

/**
 * Streaming deltas are coalesced into one patch per frame-sized window so a fast provider does not flood every Client
 * with one event per token.
 */
const PATCH_FLUSH_MS = 16;

interface ChatProjectionOptions {
    terminalId: string;
    /**
     * Where this projection's revisions start; see `AgentChatService.revisionFloors`.
     */
    revision: number;
    taskRevisionFloors: Map<string, number>;
    logger: StructuredLogger;
    send(event: ServerEvent): void;
    /**
     * Runs after every change, so the follow-up queue can react to a turn ending.
     */
    onChange(): void;
}

/**
 * One Chat's in-memory projection: the snapshot every Client mirrors, its task projections, and the operations not yet
 * flushed as `agentChat.patch` / `agentChat.taskPatch` events.
 */
export class ChatProjection {
    /**
     * Operations Clients have not seen yet; `snapshot.revision` advances only when they are flushed.
     */
    private readonly queued: AgentChatPatchOperation[] = [];
    private flushTimer?: NodeJS.Timeout;
    snapshot: AgentChatSnapshot;
    /**
     * Subagent conversations and background shell output, each with its own revisions.
     */
    readonly tasks: ChatTaskProjections;

    constructor(private readonly options: ChatProjectionOptions) {
        this.snapshot = {
            ...emptyAgentChatSnapshot(options.terminalId),
            revision: options.revision,
        };
        this.tasks = new ChatTaskProjections(
            options.terminalId,
            options.taskRevisionFloors,
            () => this.snapshot.tasks ?? [],
            (payload) => options.send({ event: 'agentChat.taskPatch', payload }),
        );
    }

    private scheduleFlush(): void {
        if (this.queued.length + this.tasks.pendingCount >= MAX_AGENT_CHAT_PATCH_OPERATIONS)
            this.flush();
        else
            this.flushTimer ??= setTimeout(() => {
                this.flushTimer = undefined;
                this.flush();
            }, PATCH_FLUSH_MS);
    }

    /**
     * Logs tasks that just reached a final status.
     */
    private logFinishedTasks(previous: readonly AgentChatTask[]): void {
        const before = new Map(previous.map((task) => [task.id, task]));
        const tasks = this.snapshot.tasks ?? [];
        for (const task of tasks) {
            const old = before.get(task.id);
            if (task.status === 'running' || (old && old.status !== 'running')) continue;
            this.options.logger.write('info', logEventCatalog.agentChat.taskFinished, {
                fields: {
                    terminalId: this.options.terminalId,
                    kind: task.kind,
                    status: task.status,
                    isBackground: task.isBackground,
                    durationMs:
                        task.startedAt !== undefined && task.endedAt !== undefined
                            ? task.endedAt - task.startedAt
                            : null,
                },
            });
        }
    }

    apply(operations: readonly AgentChatPatchOperation[]): void {
        if (operations.length === 0) return;
        const previousTasks = this.snapshot.tasks;
        for (const operation of operations)
            this.snapshot = applyAgentChatOperation(this.snapshot, operation);
        if (this.snapshot.tasks !== previousTasks) this.logFinishedTasks(previousTasks ?? []);
        this.queued.push(...operations);
        this.scheduleFlush();
        this.options.onChange();
    }

    applyTask(taskId: string, operations: readonly AgentChatTaskPatchOperation[]): void {
        if (operations.length === 0) return;
        this.tasks.apply(taskId, operations);
        this.scheduleFlush();
    }

    /**
     * Emits queued operations as one patch. A Client whose copy is at `baseRevision` applies them; any other Client
     * re-reads. Called before every read so a snapshot never contains operations a later patch would apply again.
     */
    flush(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        const { terminalId } = this.options;
        while (this.queued.length > 0) {
            const operations = this.queued.splice(0, MAX_AGENT_CHAT_PATCH_OPERATIONS);
            const baseRevision = this.snapshot.revision;
            this.snapshot = { ...this.snapshot, revision: baseRevision + 1 };
            this.options.send({
                event: 'agentChat.patch',
                payload: { terminalId, baseRevision, revision: baseRevision + 1, operations },
            });
        }
        this.tasks.flush();
    }

    /**
     * Drops pending patches so none reaches Clients after a replacement chain began. Returns the revision the next
     * projection of this Chat starts from.
     */
    retire(): number {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        this.tasks.retire();
        return this.snapshot.revision + 1;
    }
}
