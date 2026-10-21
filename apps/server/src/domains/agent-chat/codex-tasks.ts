import type { AgentChatTask, AgentChatTaskPatchOperation } from '@caxri/protocol';
import { CaxriError, MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import { clip, closeDanglingItem, isRecord, stringField } from './chat-items';
import type { AgentChatSessionHost, ChatTaskHistory } from './chat-provider';
import { ChatTaskList } from './chat-tasks';
import { CodexBackgroundTerminals } from './codex-background-terminals';
import { CodexComputerUseBindings } from './codex-computer-use';
import { codexAgentName, mapCodexItem } from './codex-items';
import { historyItems } from './codex-turns';
import { JsonRpcRequestError } from './json-rpc-connection';

/**
 * Background work of one Codex Chat: subagent threads and background terminals, projected into the parent snapshot's
 * `tasks` and each task's own projection.
 *
 * - A subagent is a child thread. Its notifications arrive on the same app-server connection with the child's `threadId`
 *   (app-server attaches every thread the process creates to every initialized connection), but Codex sends no
 *   `thread/started` for a spawned thread. The child is identified by the parent's `collabAgentToolCall`
 *   (`receiverThreadIds`) or multi-agent v2's `subAgentActivity` (`agentThreadId`), which can arrive after the child's
 *   first events, so notifications of an unknown thread are buffered briefly. The task id is the child thread id.
 * - A background terminal is tracked by {@link CodexBackgroundTerminals}; this class shares its task list with it.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs
 */

type Json = Record<string, unknown>;
type CodexRequest = (method: string, parameters: unknown, timeoutMs?: number) => Promise<unknown>;

/**
 * Unknown threads whose notifications are held until a collab item names them, and how many each may hold. Threads
 * nobody claims (guardian or review threads) fall out of this window.
 */
const MAX_PENDING_THREADS = 8;
const MAX_PENDING_NOTIFICATIONS = 500;
/**
 * Collab items whose receivers are remembered, so a tab opened from a timeline row finds its thread.
 */
const MAX_TRACKED_COLLAB_ITEMS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

interface ChildThread {
    activeTurnId?: string;
    /**
     * The child's own Computer Use bindings: each thread runs its own `cua_repl` REPL scope, so a variable a subagent
     * bound in an earlier step names its surface only within that thread (#1945).
     */
    computerUse: CodexComputerUseBindings;
}

interface PendingNotification {
    method: string;
    parameters: Json;
}

/**
 * Closed agent states Codex reports in `agentsStates`, mapped to a task status. `undefined` leaves the status alone
 * (`pendingInit`, `notFound`, and unknown values say nothing new).
 */
function agentStateStatus(value: unknown): AgentChatTask['status'] | undefined {
    switch (value) {
        case 'running': {
            return 'running';
        }
        case 'completed':
        case 'shutdown': {
            return 'completed';
        }
        case 'errored': {
            return 'failed';
        }
        case 'interrupted': {
            return 'stopped';
        }
        default: {
            return undefined;
        }
    }
}

function turnTaskStatus(value: unknown): AgentChatTask['status'] {
    switch (value) {
        case 'completed': {
            return 'completed';
        }
        case 'failed': {
            return 'failed';
        }
        case 'inProgress': {
            return 'running';
        }
        default: {
            return 'stopped';
        }
    }
}

/**
 * The subagent's first prompt line, which is what the user reads as its task.
 */
function promptTitle(prompt: unknown): string | undefined {
    const line = stringField(prompt)
        ?.split('\n')
        .find((candidate) => candidate.trim());
    return line ? clip(line.trim(), 1_000) : undefined;
}

function parentThreadId(thread: Json): string | undefined {
    const direct = stringField(thread.parentThreadId);
    if (direct) return direct;
    const source = isRecord(thread.source) ? thread.source.subAgent : undefined;
    const spawn = isRecord(source) ? source.thread_spawn : undefined;
    return isRecord(spawn) ? stringField(spawn.parent_thread_id) : undefined;
}

export class CodexTasks {
    private readonly list: ChatTaskList;

    private readonly children = new Map<string, ChildThread>();

    private readonly pendingThreads = new Map<string, PendingNotification[]>();

    private readonly collabReceivers = new Map<string, string[]>();

    private readonly terminals: CodexBackgroundTerminals;

    constructor(
        private readonly host: Pick<
            AgentChatSessionHost,
            'apply' | 'applyTask' | 'read' | 'readTask'
        >,
        private readonly options: {
            request: CodexRequest;
            threadId: () => string | undefined;
        },
    ) {
        this.list = new ChatTaskList(host);
        this.terminals = new CodexBackgroundTerminals(host, this.list, options);
    }

    private rememberReceivers(itemId: string, receivers: string[]): void {
        this.collabReceivers.delete(itemId);
        this.collabReceivers.set(itemId, receivers);
        for (const key of this.collabReceivers.keys()) {
            if (this.collabReceivers.size <= MAX_TRACKED_COLLAB_ITEMS) break;
            this.collabReceivers.delete(key);
        }
    }

    private adopt(threadId: string, fields: Partial<Omit<AgentChatTask, 'id'>>): void {
        const isNew = !this.children.has(threadId);
        if (isNew) this.children.set(threadId, { computerUse: new CodexComputerUseBindings() });
        const existing = this.list.get(threadId);
        this.list.upsert(threadId, {
            ...(!existing && {
                kind: 'agent' as const,
                title: 'Subagent',
                status: 'running' as const,
                isBackground: true,
                canStop: false,
            }),
            ...fields,
        });
        if (!isNew) return;
        const pending = this.pendingThreads.get(threadId) ?? [];
        this.pendingThreads.delete(threadId);
        for (const notification of pending)
            this.handleChild(threadId, notification.method, notification.parameters);
    }

    private applyTask(taskId: string, operations: AgentChatTaskPatchOperation[]): void {
        if (operations.length > 0) this.host.applyTask(taskId, operations);
    }

    private appendTaskText(taskId: string, itemId: unknown, delta: unknown): void {
        if (typeof itemId !== 'string' || typeof delta !== 'string' || !delta) return;
        this.applyTask(taskId, [
            {
                op: 'appendText',
                itemId: clip(itemId, 200),
                delta: clip(delta, MAX_AGENT_CHAT_TEXT_LENGTH),
            },
        ]);
    }

    private handleChild(threadId: string, method: string, parameters: Json): void {
        const child = this.children.get(threadId);
        if (!child) return;
        const turnId = stringField(parameters.turnId);
        switch (method) {
            case 'turn/started': {
                const turn = isRecord(parameters.turn) ? parameters.turn : undefined;
                const id = stringField(turn?.id);
                if (!id) return;
                child.activeTurnId = clip(id, 200);
                this.list.upsert(threadId, { status: 'running', canStop: true });
                return;
            }
            case 'turn/completed': {
                if (isRecord(parameters.turn)) this.finishChildTurn(threadId, parameters.turn);
                return;
            }
            case 'item/started':
            case 'item/completed': {
                const raw = parameters.item;
                if (!isRecord(raw)) return;
                const isStarted = method === 'item/started';
                const item = mapCodexItem(raw, turnId, isStarted, child.computerUse);
                if (item) this.applyTask(threadId, [{ op: 'upsertItem', item }]);
                if (raw.type === 'collabAgentToolCall' || raw.type === 'subAgentActivity')
                    this.onAgentItem(raw);
                if (isStarted && item?.type === 'command')
                    this.list.upsert(threadId, { lastToolName: 'shell' });
                else if (isStarted && item?.type === 'toolCall')
                    this.list.upsert(threadId, { lastToolName: item.name });
                else if (isStarted && item?.type === 'fileChange')
                    this.list.upsert(threadId, { lastToolName: 'fileChange' });
                if (!isStarted && item?.type === 'agentMessage' && item.text)
                    this.list.upsert(threadId, { summary: clip(item.text, 2_000) });
                return;
            }
            case 'item/agentMessage/delta':
            case 'item/reasoning/summaryTextDelta':
            case 'item/commandExecution/outputDelta': {
                this.appendTaskText(threadId, parameters.itemId, parameters.delta);
                return;
            }
            case 'item/reasoning/summaryPartAdded': {
                if (typeof parameters.summaryIndex === 'number' && parameters.summaryIndex > 0)
                    this.appendTaskText(threadId, parameters.itemId, '\n\n');
                return;
            }
            case 'thread/tokenUsage/updated': {
                const usage = isRecord(parameters.tokenUsage) ? parameters.tokenUsage : undefined;
                const total = isRecord(usage?.total) ? usage.total.totalTokens : undefined;
                if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return;
                const previous = this.list.get(threadId)?.usage;
                this.list.upsert(threadId, {
                    usage: { ...previous, totalTokens: Math.trunc(total) },
                });
                return;
            }
            default: {
                // Child status, warnings, and plans are not part of the task's conversation.
            }
        }
    }

    private finishChildTurn(threadId: string, turn: Json): void {
        const child = this.children.get(threadId);
        const id = stringField(turn.id);
        if (!child || !id) return;
        const turnId = clip(id, 200);
        const operations: AgentChatTaskPatchOperation[] = [];
        const items = this.host.readTask(threadId)?.items ?? [];
        for (const item of items) {
            if (item.turnId !== undefined && item.turnId !== turnId) continue;
            const closed = closeDanglingItem(item);
            if (closed) operations.push({ op: 'upsertItem', item: closed });
        }
        const status = turnTaskStatus(turn.status);
        const error = isRecord(turn.error) ? stringField(turn.error.message) : undefined;
        if (status === 'failed' && error)
            operations.push({
                op: 'upsertItem',
                item: {
                    id: `${turnId}:error`,
                    turnId,
                    type: 'notice',
                    kind: 'error',
                    message: clip(error, 2_000),
                },
            });
        this.applyTask(threadId, operations);
        if (child.activeTurnId === turnId) child.activeTurnId = undefined;
        const durationMs =
            typeof turn.durationMs === 'number' && turn.durationMs >= 0
                ? turn.durationMs
                : undefined;
        const previous = this.list.get(threadId)?.usage;
        this.list.upsert(threadId, {
            status,
            canStop: false,
            ...(durationMs !== undefined && {
                usage: { ...previous, durationMs: (previous?.durationMs ?? 0) + durationMs },
            }),
        });
    }

    /**
     * Whether a notification for `threadId` belongs to a subagent rather than the Chat's own thread.
     */
    isOtherThread(threadId: string | undefined): threadId is string {
        return threadId !== undefined && threadId !== this.options.threadId();
    }

    /**
     * `thread/started` for a thread whose parent is this Chat or one of its subagents. Codex does not send it for
     * spawned threads today; when a version does, the task appears before the collab item completes.
     */
    onThreadStarted(thread: unknown): void {
        if (!isRecord(thread)) return;
        const id = stringField(thread.id);
        const parent = parentThreadId(thread);
        if (!id || !parent || (parent !== this.options.threadId() && !this.children.has(parent)))
            return;
        const source = isRecord(thread.source) ? thread.source.subAgent : undefined;
        const spawn = isRecord(source) && isRecord(source.thread_spawn) ? source.thread_spawn : {};
        const nickname = stringField(thread.agentNickname) ?? stringField(spawn.agent_nickname);
        const role = stringField(thread.agentRole) ?? stringField(spawn.agent_role);
        const model = stringField(thread.model);
        this.adopt(id, {
            ...(nickname && !this.list.get(id) && { title: clip(nickname, 1_000) }),
            ...(role && { agentType: role }),
            ...(model && { model }),
        });
    }

    /**
     * Routes a notification of a thread other than the Chat's own into its subagent task, or holds it until a collab
     * item says which task the thread belongs to.
     */
    onChildNotification(threadId: string, method: string, parameters: Json): void {
        if (this.children.has(threadId)) {
            this.handleChild(threadId, method, parameters);
            return;
        }
        let pending = this.pendingThreads.get(threadId);
        if (!pending) {
            pending = [];
            this.pendingThreads.set(threadId, pending);
            for (const key of this.pendingThreads.keys()) {
                if (this.pendingThreads.size <= MAX_PENDING_THREADS) break;
                this.pendingThreads.delete(key);
            }
        }
        if (pending.length < MAX_PENDING_NOTIFICATIONS) pending.push({ method, parameters });
    }

    /**
     * A `collabAgentToolCall` or `subAgentActivity` item of the Chat's thread or of a subagent (which can spawn its
     * own).
     */
    onAgentItem(raw: Json): void {
        const id = stringField(raw.id);
        if (!id) return;
        if (raw.type === 'subAgentActivity') {
            const threadId = stringField(raw.agentThreadId);
            if (!threadId) return;
            this.rememberReceivers(id, [threadId]);
            const model = stringField(raw.model);
            switch (raw.kind) {
                case 'started': {
                    const name = codexAgentName(raw.agentPath, 1_000);
                    this.adopt(threadId, {
                        itemId: id,
                        ...(name && !this.list.get(threadId) && { title: name }),
                        ...(model && { model }),
                    });
                    return;
                }
                case 'interrupted': {
                    if (this.children.has(threadId))
                        this.list.upsert(threadId, { status: 'stopped' });
                    return;
                }
                case 'completed': {
                    if (this.children.has(threadId))
                        this.list.upsert(threadId, { status: 'completed' });
                    return;
                }
                default: {
                    return;
                }
            }
        }
        const receivers = Array.isArray(raw.receiverThreadIds)
            ? raw.receiverThreadIds.filter(
                  (value): value is string => typeof value === 'string' && value.length > 0,
              )
            : [];
        if (receivers.length > 0) this.rememberReceivers(id, receivers);
        const states = isRecord(raw.agentsStates) ? raw.agentsStates : {};
        if (raw.tool === 'spawnAgent') {
            const title = promptTitle(raw.prompt);
            const model = stringField(raw.model);
            for (const threadId of receivers)
                this.adopt(threadId, {
                    itemId: id,
                    ...(title && { title }),
                    ...(model && { model }),
                });
        }
        for (const [threadId, state] of Object.entries(states)) {
            if (!this.children.has(threadId) || !isRecord(state)) continue;
            const status = agentStateStatus(state.status);
            const summary = stringField(state.message);
            if (!status && !summary) continue;
            /**
             * A child's own turn events are the precise signal; a state report only settles a task whose turn already
             * ended (or never reported), so a stale `running` cannot reopen a finished task.
             */
            const isLive = this.children.get(threadId)?.activeTurnId !== undefined;
            this.list.upsert(threadId, {
                ...(status && (!isLive || status === 'running') && { status }),
                ...(summary && { summary }),
            });
        }
    }

    /**
     * A `commandExecution` item of the Chat's own thread; see {@link CodexBackgroundTerminals.onItem}.
     */
    onCommandItem(raw: Json, turnId: string | undefined, isStarted: boolean): void {
        this.terminals.onItem(raw, turnId, isStarted);
    }

    /**
     * `item/commandExecution/outputDelta` of the Chat's own thread; see {@link CodexBackgroundTerminals.onOutput}.
     */
    onCommandOutput(itemId: unknown, delta: unknown): void {
        this.terminals.onOutput(itemId, delta);
    }

    /**
     * The Chat's turn ended; see {@link CodexBackgroundTerminals.onTurnFinished}.
     */
    onTurnFinished(turnId: string): ReadonlySet<string> {
        return this.terminals.onTurnFinished(turnId);
    }

    /**
     * Reconciles background terminals with Codex's list; see {@link CodexBackgroundTerminals.reconcile}.
     */
    reconcileTerminals(): Promise<void> {
        return this.terminals.reconcile();
    }

    /**
     * Rebuilds subagent and background terminal tasks from a resumed thread's history: their timeline rows stay
     * openable, and they are ended, because the process that ran them is gone.
     */
    replay(thread: Json): void {
        const turns = Array.isArray(thread.turns) ? thread.turns : [];
        const agentItems = turns.flatMap((turn) =>
            isRecord(turn) && Array.isArray(turn.items)
                ? turn.items.filter(
                      (raw): raw is Json =>
                          isRecord(raw) &&
                          (raw.type === 'collabAgentToolCall' || raw.type === 'subAgentActivity'),
                  )
                : [],
        );
        for (const raw of agentItems) this.onAgentItem(raw);
        this.terminals.replay(turns);
        for (const threadId of this.children.keys()) {
            const task = this.list.get(threadId);
            if (task?.status === 'running') this.list.upsert(threadId, { status: 'stopped' });
        }
        this.children.clear();
    }

    /**
     * The provider process ended and took every subagent and terminal with it.
     */
    end(): void {
        this.list.stopAll();
        this.children.clear();
        this.terminals.clear();
        this.pendingThreads.clear();
    }

    async stopTask(taskId: string): Promise<void> {
        const task = this.list.get(taskId);
        if (task?.status !== 'running')
            throw new CaxriError('CONFLICT', 'This task is no longer running');
        try {
            if (task.kind === 'agent') {
                const turnId = this.children.get(taskId)?.activeTurnId;
                if (!turnId) throw new CaxriError('CONFLICT', 'This task is no longer running');
                /**
                 * App-server resolves the subagent thread like any loaded thread; interrupting its turn stops the
                 * subagent without touching the Chat's own turn. Its `turn/completed` settles the task.
                 */
                await this.options.request(
                    'turn/interrupt',
                    { threadId: taskId, turnId },
                    REQUEST_TIMEOUT_MS,
                );
                return;
            }
            await this.terminals.stop(taskId);
        } catch (error) {
            if (error instanceof JsonRpcRequestError)
                throw new CaxriError('CONFLICT', 'This task is no longer running');
            throw error;
        }
    }

    /**
     * A task's projection rebuilt from Codex's record: a subagent's thread through `thread/read`, or a terminal's
     * output from its timeline row. `taskId` may be the collab item that spawned the subagent.
     */
    async readTaskHistory(taskId: string): Promise<ChatTaskHistory | undefined> {
        const listed = this.list.get(taskId) ?? this.list.byItem(taskId);
        if (listed?.kind === 'shell') return this.terminals.history(listed.id);
        const threadId =
            this.collabReceivers.get(taskId)?.[0] ??
            (listed?.kind === 'agent' ? listed.id : undefined);
        if (!threadId) return undefined;
        let result: unknown;
        try {
            result = await this.options.request(
                'thread/read',
                { threadId, includeTurns: true },
                REQUEST_TIMEOUT_MS,
            );
        } catch {
            return undefined;
        }
        const thread = isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
        if (thread?.id !== threadId) return undefined;
        const turns = Array.isArray(thread.turns) ? thread.turns : [];
        const items = turns.flatMap((turn) => {
            if (!isRecord(turn)) return [];
            const turnId = stringField(turn.id);
            return turnId ? historyItems(turn.items, turnId, turn.status === 'inProgress') : [];
        });
        // Every item is replayed: the task projection keeps the newest ones and archives the rest for paging.
        const operations: AgentChatTaskPatchOperation[] = items.map((item) => ({
            op: 'upsertItem',
            item,
        }));
        return { taskId: threadId, operations };
    }
}
