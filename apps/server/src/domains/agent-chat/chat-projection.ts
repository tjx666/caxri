import { randomUUID } from 'node:crypto';

import type {
    AgentChatDelegatedTaskSource,
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTask,
    AgentChatTaskPatchOperation,
    AgentChatTurn,
    ServerEvent,
} from '@caxri/protocol';
import {
    applyAgentChatOperation,
    emptyAgentChatSnapshot,
    MAX_AGENT_CHAT_ITEMS,
    MAX_AGENT_CHAT_PATCH_OPERATIONS,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { stampDelegatedTasks } from './chat-delegated-task';
import { ChatHistoryArchive } from './chat-history-archive';
import { ChatTaskProjections } from './chat-task-projections';

/**
 * Streaming deltas are coalesced into one patch per frame-sized window so a fast provider does not flood every Client
 * with one event per token.
 */
const PATCH_FLUSH_MS = 16;

interface ChatProjectionOptions {
    terminalId: string;
    /**
     * Where this projection's revisions start; see `ChatStates.revisionFloors`.
     */
    revision: number;
    taskRevisionFloors: Map<string, number>;
    logger: StructuredLogger;
    send(event: ServerEvent): void;
    /**
     * Runs after every change, so the follow-up queue can react to a turn ending.
     */
    onChange(): void;
    /**
     * Names the Session a delegated task came from; see {@link stampDelegatedTasks}.
     */
    delegatedTaskSource(delegationId: string): AgentChatDelegatedTaskSource | undefined;
}

/**
 * Stamps `createdAt` on each item that enters the projection live, so the transcript can say when a message was sent or
 * answered. Every provider rebuilds history as one batch led by `reset`, and an item after that `reset` is a replay
 * whose real time is long past: it keeps whatever time its provider recorded, or none, rather than the time of the
 * replay. Later upserts of a stamped item inherit the stamp in the shared reducer.
 */
export function stampNewItems(
    snapshot: AgentChatSnapshot,
    operations: readonly AgentChatPatchOperation[],
    now: number,
): readonly AgentChatPatchOperation[] {
    if (operations.some((operation) => operation.op === 'reset')) return operations;
    const known = new Set(snapshot.items.map((item) => item.id));
    let stamped: AgentChatPatchOperation[] | undefined;
    for (const [index, operation] of operations.entries()) {
        if (operation.op !== 'upsertItem') continue;
        const { item } = operation;
        if (item.createdAt === undefined && !known.has(item.id)) {
            stamped ??= [...operations];
            stamped[index] = { op: 'upsertItem', item: { ...item, createdAt: now } };
        }
        known.add(item.id);
    }
    return stamped ?? operations;
}

/**
 * Names who stopped each interrupted turn Caxri was asked to stop. No provider reports who interrupted a turn, so the
 * Server Core that relayed the Stop remembers it by turn id and stamps it whenever that turn arrives `interrupted`,
 * including in a later history replay of the same Chat.
 */
export function stampStoppedTurns(
    operations: readonly AgentChatPatchOperation[],
    stops: ReadonlyMap<string, NonNullable<AgentChatTurn['stoppedBy']>>,
): readonly AgentChatPatchOperation[] {
    if (stops.size === 0) return operations;
    return operations.map((operation) => {
        if (operation.op !== 'state' || !operation.state.turns) return operation;
        const original = operation.state.turns;
        const turns = original.map((turn) => {
            const stoppedBy = stops.get(turn.id);
            if (!stoppedBy || turn.status !== 'interrupted' || turn.stoppedBy === stoppedBy)
                return turn;
            return { ...turn, stoppedBy };
        });
        return turns.some((turn, index) => turn !== original[index])
            ? { ...operation, state: { ...operation.state, turns } }
            : operation;
    });
}

/**
 * Keeps each `answered` notice through a history replay. Server Core records the notice itself when the user answers a
 * question (`agentChatAnsweredNotice`); no provider's history carries it, so the `reset` batch that rebuilds a resumed
 * Chat (Retry after a crash, or any restart of the provider process) would otherwise drop it and leave the Agent acting
 * on a choice the transcript no longer mentions. A notice stays only while the replay still holds its turn, so a rewind
 * past that turn drops it. It goes back after the item it followed, or after its turn's first item (the user's message)
 * when that item's replayed id differs. It survives only within this Server Core process: the notice is not persisted.
 */
export function carryAnsweredNotices(
    previous: readonly AgentChatItem[],
    operations: readonly AgentChatPatchOperation[],
): readonly AgentChatPatchOperation[] {
    const resetIndex = operations.findIndex((operation) => operation.op === 'reset');
    if (resetIndex === -1) return operations;
    const notices = previous.flatMap((item, index) =>
        item.type === 'notice' && item.kind === 'answered' && item.turnId !== undefined
            ? [{ notice: item, after: index > 0 ? previous[index - 1].id : undefined }]
            : [],
    );
    if (notices.length === 0) return operations;
    const carried = [...operations];
    let isChanged = false;
    const upsertIndex = (isMatch: (item: AgentChatItem) => boolean): number =>
        carried.findIndex(
            (operation, index) =>
                index > resetIndex && operation.op === 'upsertItem' && isMatch(operation.item),
        );
    for (const { notice, after } of notices) {
        if (upsertIndex((item) => item.id === notice.id) !== -1) continue;
        let index =
            after === undefined
                ? -1
                : upsertIndex((item) => item.id === after && item.turnId === notice.turnId);
        if (index === -1) index = upsertIndex((item) => item.turnId === notice.turnId);
        if (index === -1) continue;
        carried.splice(index + 1, 0, { op: 'upsertItem', item: notice });
        isChanged = true;
    }
    return isChanged ? carried : operations;
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
    /**
     * The replaced projection's items, held by a restart until this projection's first history replay carries their
     * `answered` notices over (see {@link carryAnsweredNotices}).
     */
    private replacedItems: readonly AgentChatItem[] = [];
    /**
     * Who asked to stop each turn; see {@link stampStoppedTurns}.
     */
    private stops = new Map<string, NonNullable<AgentChatTurn['stoppedBy']>>();
    snapshot: AgentChatSnapshot;
    /**
     * Subagent conversations and background shell output, each with its own revisions.
     */
    readonly tasks: ChatTaskProjections;
    /**
     * Items the projection's budget evicted, which `agentChat.readHistory` pages through.
     */
    readonly history = new ChatHistoryArchive();

    constructor(private readonly options: ChatProjectionOptions) {
        this.snapshot = {
            ...emptyAgentChatSnapshot(options.terminalId),
            revision: options.revision,
            historyId: randomUUID(),
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

    /**
     * A provider reports every turn it knows, including turns whose items now live only in the archive. Those stay out
     * of the projection, which keeps only the turns its own items belong to. Nor may a provider clear `truncated` while
     * the archive holds history.
     */
    private withoutArchivedTurns(operation: AgentChatPatchOperation): AgentChatPatchOperation {
        if (operation.op !== 'state') return operation;
        // The archive holds older history, whatever the provider believes it loaded.
        if (operation.state.truncated === false && this.history.size > 0)
            return this.withoutArchivedTurns({
                op: 'state',
                state: { ...operation.state, truncated: true },
            });
        if (!operation.state.turns) return operation;
        const { turns } = operation.state;
        let kept = turns;
        if (this.history.size > 0) {
            this.history.recordTurns(turns);
            const live = new Set(this.snapshot.items.map((item) => item.turnId));
            const activeTurnId =
                operation.state.activeTurnId === undefined
                    ? this.snapshot.activeTurnId
                    : operation.state.activeTurnId;
            kept = turns.filter(
                (turn) =>
                    !this.history.hasTurn(turn.id) || live.has(turn.id) || turn.id === activeTurnId,
            );
        }
        // A resumed history reports every turn; the projection's schema bounds them like its items.
        if (kept.length > MAX_AGENT_CHAT_ITEMS) kept = kept.slice(-MAX_AGENT_CHAT_ITEMS);
        return kept.length === turns.length
            ? operation
            : { op: 'state', state: { ...operation.state, turns: kept } };
    }

    /**
     * Drops the operations for items a replacement batch evicted again before any Client saw them. A Client applying
     * the rest never reaches the budget that evicted them, so the patch states the truncation the Server-side
     * projection reached.
     */
    private withoutEvictedItems(
        operations: readonly AgentChatPatchOperation[],
        evicted: ReadonlySet<string>,
    ): readonly AgentChatPatchOperation[] {
        if (evicted.size === 0) return operations;
        const live = new Set(this.snapshot.items.map((item) => item.id));
        const kept = operations.filter((operation) => {
            const id =
                operation.op === 'upsertItem'
                    ? operation.item.id
                    : operation.op === 'appendText'
                      ? operation.itemId
                      : undefined;
            return id === undefined || !evicted.has(id) || live.has(id);
        });
        return [...kept, { op: 'state', state: { truncated: this.snapshot.truncated } }];
    }

    apply(operations: readonly AgentChatPatchOperation[]): void {
        if (operations.length === 0) return;
        const previousTasks = this.snapshot.tasks;
        const isHistoryReplay = operations.some((operation) => operation.op === 'reset');
        const carried = isHistoryReplay
            ? carryAnsweredNotices([...this.replacedItems, ...this.snapshot.items], operations)
            : operations;
        const timed = stampStoppedTurns(
            stampNewItems(this.snapshot, carried, Date.now()),
            this.stops,
        );
        const stamped = stampDelegatedTasks(timed, (delegationId) =>
            this.options.delegatedTaskSource(delegationId),
        );
        if (isHistoryReplay) this.replacedItems = [];
        const isReplacement = stamped.some((operation) => operation.op === 'reset');
        const applied: AgentChatPatchOperation[] = [];
        /**
         * Items a replacement upserted and then evicted within the same batch. Clients never need them in their
         * projection, so they are left out of the patch: a resumed history of thousands of items reaches Clients as
         * only the part the projection keeps, and the rest waits in the archive for `agentChat.readHistory`.
         */
        const evictedInBatch = new Set<string>();
        for (const original of stamped) {
            const operation = this.withoutArchivedTurns(original);
            const before = this.snapshot;
            this.snapshot = applyAgentChatOperation(before, operation);
            applied.push(operation);
            if (operation.op === 'reset') {
                this.history.clear();
                const historyId = randomUUID();
                this.snapshot = applyAgentChatOperation(this.snapshot, {
                    op: 'state',
                    state: { historyId },
                });
                applied.push({ op: 'state', state: { historyId } });
                continue;
            }
            for (const item of this.history.recordEviction(before, this.snapshot))
                if (isReplacement) evictedInBatch.add(item.id);
            // The provider loaded only part of its history; the rest is in its own record.
            if (original.op === 'state' && original.state.truncated === true)
                this.history.isIncomplete = true;
        }
        if (this.snapshot.tasks !== previousTasks) this.logFinishedTasks(previousTasks ?? []);
        this.queued.push(...this.withoutEvictedItems(applied, evictedInBatch));
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
     * Takes over what a restart replaced: the provider rebuilds history into this new projection, and Server Core's own
     * `answered` notices exist only in the replaced one.
     */
    adoptReplaced(previous: ChatProjection): void {
        this.replacedItems = previous.snapshot.items;
        this.stops = new Map(previous.stops);
    }

    /**
     * Records that `by` asked to stop the running turn, so it is labeled with who stopped it once it ends interrupted.
     */
    noteStopRequest(by: NonNullable<AgentChatTurn['stoppedBy']>): void {
        const { activeTurnId } = this.snapshot;
        if (activeTurnId) this.stops.set(activeTurnId, by);
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
