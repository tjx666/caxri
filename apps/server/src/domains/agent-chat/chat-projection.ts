import { randomUUID } from 'node:crypto';

import type {
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

import type { DelegatedTaskDetails } from './chat-delegated-task';
import { stampDelegatedTasks } from './chat-delegated-task';
import { ChatHistoryArchive } from './chat-history-archive';
import { ChatTaskProjections } from './chat-task-projections';

/**
 * Streaming deltas are coalesced into one patch per frame-sized window so a fast provider does not flood every Client
 * with one event per token.
 */
const PATCH_FLUSH_MS = 16;

/**
 * How long after idle compaction asks the provider to compact its `compacted` notice is still labeled `idle`; a
 * compaction of a context large enough for idle compaction finishes well within it.
 */
const IDLE_COMPACTION_LABEL_WINDOW_MS = 10 * 60_000;

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
     * The Session a delegated task came from and the task it asked; see {@link stampDelegatedTasks}.
     */
    delegatedTask(delegationId: string): DelegatedTaskDetails;
    /**
     * Runs when the task list changed, with the new list (`undefined` once a `reset` cleared it). The sidebar's durable
     * subagent summaries follow it; see `ChatSubagentSummaries`.
     */
    onTasksChanged?(tasks: readonly AgentChatTask[] | undefined): void;
    /**
     * Where `answered` notices outlive this Server Core process; see {@link AnsweredNoticeStore}.
     */
    answeredNotices?: AnsweredNoticeStore;
}

/**
 * Durable storage for the `answered` notices of one Chat, so a history replay after a Server Core restart can put them
 * back (see {@link carryAnsweredNotices}).
 */
interface AnsweredNoticeStore {
    load(): readonly AnsweredNoticeEntry[];
    save(notice: AgentChatItem, after: string | undefined): void;
    remove(itemIds: readonly string[]): void;
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
 * An `answered` notice with the id of the item it followed, the anchor a replay re-inserts it after.
 */
interface AnsweredNoticeEntry {
    notice: AgentChatItem;
    after: string | undefined;
}

/**
 * The `answered` notices among `items`, each with the item that precedes it.
 */
function answeredNoticeEntries(items: readonly AgentChatItem[]): AnsweredNoticeEntry[] {
    return items.flatMap((item, index) =>
        item.type === 'notice' && item.kind === 'answered' && item.turnId !== undefined
            ? [{ notice: item, after: index > 0 ? items[index - 1].id : undefined }]
            : [],
    );
}

/**
 * Keeps each `answered` notice through a history replay. Server Core records the notice itself when the user answers a
 * question (`agentChatAnsweredNotice`); no provider's history carries it, so the `reset` batch that rebuilds a resumed
 * Chat (Retry after a crash, any restart of the provider process, or a Server Core restart) would otherwise drop it and
 * leave the Agent acting on a choice the transcript no longer mentions. A notice stays only while the replay still
 * holds its turn, so a rewind past that turn drops it. It goes back after the item it followed, or after its turn's
 * first item (the user's message) when that item's replayed id differs. Notices are persisted (see
 * {@link AnsweredNoticeStore}); `dropped` lists the ones this replay no longer holds a place for.
 */
function carryAnsweredNoticeEntries(
    entries: readonly AnsweredNoticeEntry[],
    operations: readonly AgentChatPatchOperation[],
): { operations: readonly AgentChatPatchOperation[]; dropped: string[] } {
    const resetIndex = operations.findIndex((operation) => operation.op === 'reset');
    if (resetIndex === -1 || entries.length === 0) return { operations, dropped: [] };
    const carried = [...operations];
    let isChanged = false;
    const dropped: string[] = [];
    const upsertIndex = (isMatch: (item: AgentChatItem) => boolean): number =>
        carried.findIndex(
            (operation, index) =>
                index > resetIndex && operation.op === 'upsertItem' && isMatch(operation.item),
        );
    for (const { notice, after } of entries) {
        if (upsertIndex((item) => item.id === notice.id) !== -1) continue;
        let index =
            after === undefined
                ? -1
                : upsertIndex((item) => item.id === after && item.turnId === notice.turnId);
        if (index === -1) index = upsertIndex((item) => item.turnId === notice.turnId);
        if (index === -1) {
            dropped.push(notice.id);
            continue;
        }
        carried.splice(index + 1, 0, { op: 'upsertItem', item: notice });
        isChanged = true;
    }
    return { operations: isChanged ? carried : operations, dropped };
}

/**
 * {@link carryAnsweredNoticeEntries} over the notices found in `previous` items.
 */
export function carryAnsweredNotices(
    previous: readonly AgentChatItem[],
    operations: readonly AgentChatPatchOperation[],
): readonly AgentChatPatchOperation[] {
    return carryAnsweredNoticeEntries(answeredNoticeEntries(previous), operations).operations;
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
    /**
     * Until when the next live `compacted` notice is idle compaction's; see {@link noteIdleCompaction}.
     */
    private idleCompactionUntil: number | undefined;
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

    /**
     * Re-inserts the `answered` notices a history replay does not carry: those this process holds and the ones saved
     * before a restart. A notice whose turn the replay no longer holds is deleted, but only from a replay that rebuilt
     * some history, so a transient empty read cannot erase them.
     */
    private carryNotices(
        operations: readonly AgentChatPatchOperation[],
    ): readonly AgentChatPatchOperation[] {
        const { answeredNotices } = this.options;
        const entries = answeredNoticeEntries([...this.replacedItems, ...this.snapshot.items]);
        const known = new Set(entries.map((entry) => entry.notice.id));
        const stored = answeredNotices?.load() ?? [];
        for (const entry of stored) if (!known.has(entry.notice.id)) entries.push(entry);
        const result = carryAnsweredNoticeEntries(entries, operations);
        const hasHistory = operations.some((operation) => operation.op === 'upsertItem');
        if (hasHistory) answeredNotices?.remove(result.dropped);
        return result.operations;
    }

    /**
     * Saves each `answered` notice that enters the Chat live, with the item it follows (the newest item, since a live
     * upsert appends).
     */
    private persistNewNotices(
        operations: readonly AgentChatPatchOperation[],
    ): readonly AgentChatPatchOperation[] {
        const { answeredNotices } = this.options;
        if (!answeredNotices) return operations;
        for (const operation of operations) {
            if (operation.op !== 'upsertItem') continue;
            const { item } = operation;
            if (item.type !== 'notice' || item.kind !== 'answered' || item.turnId === undefined)
                continue;
            if (this.snapshot.items.some((existing) => existing.id === item.id)) continue;
            answeredNotices.save(item, this.snapshot.items.at(-1)?.id);
        }
        return operations;
    }

    private labelIdleCompaction(
        operations: readonly AgentChatPatchOperation[],
    ): readonly AgentChatPatchOperation[] {
        if (this.idleCompactionUntil === undefined) return operations;
        if (Date.now() > this.idleCompactionUntil) {
            this.idleCompactionUntil = undefined;
            return operations;
        }
        return operations.map((operation) => {
            if (
                this.idleCompactionUntil === undefined ||
                operation.op !== 'upsertItem' ||
                operation.item.type !== 'notice' ||
                operation.item.kind !== 'compacted'
            )
                return operation;
            this.idleCompactionUntil = undefined;
            return {
                ...operation,
                item: {
                    ...operation.item,
                    compaction: { ...operation.item.compaction, trigger: 'idle' as const },
                },
            };
        });
    }

    apply(operations: readonly AgentChatPatchOperation[]): void {
        if (operations.length === 0) return;
        const previousTasks = this.snapshot.tasks;
        const isHistoryReplay = operations.some((operation) => operation.op === 'reset');
        const carried = isHistoryReplay
            ? this.carryNotices(operations)
            : this.persistNewNotices(operations);
        const labeled = isHistoryReplay ? carried : this.labelIdleCompaction(carried);
        const timed = stampStoppedTurns(
            stampNewItems(this.snapshot, labeled, Date.now()),
            this.stops,
        );
        const stamped = stampDelegatedTasks(timed, (delegationId) =>
            this.options.delegatedTask(delegationId),
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
        if (this.snapshot.tasks !== previousTasks) {
            this.logFinishedTasks(previousTasks ?? []);
            this.options.onTasksChanged?.(this.snapshot.tasks);
        }
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
     * Records that idle compaction just asked the provider to compact, so the `compacted` notice that follows is
     * labeled `idle` instead of the `manual` the provider reports for a `/compact`. Providers report the notice in
     * different places within the turn (Claude Code may send it with no turn id), so the label is held for a bounded
     * window rather than tied to a turn: a compaction that failed must not label one the user starts much later.
     */
    noteIdleCompaction(now = Date.now()): void {
        this.idleCompactionUntil = now + IDLE_COMPACTION_LABEL_WINDOW_MS;
    }

    /**
     * Withdraws `noteIdleCompaction` when the provider refused the command, so a compaction the user or the provider
     * starts later is not labeled idle.
     */
    forgetIdleCompaction(): void {
        this.idleCompactionUntil = undefined;
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
