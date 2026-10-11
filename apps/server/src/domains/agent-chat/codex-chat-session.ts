import { randomUUID } from 'node:crypto';

import type {
    AgentChatMessageInput,
    AgentChatModelChange,
    AgentChatPatchOperation,
    AgentChatRequest,
} from '@caxri/protocol';
import { CaxriError, MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import {
    answeredNotice,
    clip,
    endedSessionOperations,
    isRecord,
    MAX_TRACKED_TURNS,
    questionAnswers,
    stringField,
} from './chat-items';
import type {
    AgentChatDriver,
    AgentChatProviderSession,
    AgentChatResponse,
    AgentChatSessionHost,
    ChatInputOptions,
    ChatProcessEnd,
    ChatTaskHistory,
} from './chat-provider';
import type { CodexThreadSettings } from './codex-chat-types';
import {
    CODEX_COMMANDS,
    CodexDeliveries,
    CodexThumbnails,
    codexUserInput,
    isSteerTargetGone,
} from './codex-input';
import type { CodexRequestKind } from './codex-items';
import {
    codexRequestKey,
    codexRequestKind,
    mapCodexErrorNotice,
    mapCodexItem,
    mapCodexPlan,
    mapCodexRequest,
    mapCodexUsage,
} from './codex-items';
import { CodexModelSettings } from './codex-models';
import { CodexTasks } from './codex-tasks';
import { initializeCodexConnection, openCodexThread } from './codex-thread-open';
import { finishedTurnOperations, historyOperations } from './codex-turns';
import type { JsonRpcServerRequest } from './json-rpc-connection';
import { JsonRpcConnection, JsonRpcRequestError } from './json-rpc-connection';
import { codexChatSettings, REAL_E2E_CODEX_CHAT_SETTINGS } from './launch-settings';

const TURN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The interrupt response is held until the turn actually aborts. A provider that never answers is stopped instead so
 * the Chat cannot stay stuck in a running turn.
 */
const INTERRUPT_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

interface PendingRequest {
    transportId: number | string;
    kind: CodexRequestKind;
    turnId?: string;
}

/**
 * One live `codex app-server` process bound to one Chat Terminal. It translates the provider protocol into projection
 * operations and lifecycle events; the owning service persists, broadcasts, and serializes them.
 */
class CodexChatSession implements AgentChatProviderSession {
    private readonly settings: CodexThreadSettings;

    private connection: JsonRpcConnection | undefined;

    private threadId: string | undefined;

    private isThreadBound: boolean;

    private readonly pending = new Map<string, PendingRequest>();

    private requested = false;

    private turnCount = 0;

    private rejectedRequests = 0;

    private readonly thumbnails = new CodexThumbnails();

    private readonly deliveries = new CodexDeliveries();

    private readonly tasks: CodexTasks;

    private readonly models: CodexModelSettings;

    constructor(private readonly options: AgentChatSessionHost) {
        this.settings = options.isRealAgentE2E
            ? REAL_E2E_CODEX_CHAT_SETTINGS
            : codexChatSettings(options.launch);
        this.threadId = options.agentSessionId;
        this.isThreadBound = Boolean(options.agentSessionId);
        this.tasks = new CodexTasks(options, {
            request: (method, parameters, timeoutMs) =>
                this.requireConnection().request(method, parameters, timeoutMs),
            threadId: () => this.threadId,
        });
        this.models = new CodexModelSettings(options);
    }

    private requireConnection(): JsonRpcConnection {
        if (!this.connection?.isOpen || !this.threadId)
            throw new CaxriError('UNAVAILABLE', 'Codex Chat is not running');
        return this.connection;
    }

    private loadHistory(thread: Json, model: string | undefined): void {
        this.options.apply(historyOperations(thread, model));
        this.tasks.replay(thread);
    }

    private beginTurn(turnId: string): void {
        const id = clip(turnId, 200);
        const snapshot = this.options.read();
        if (snapshot.turns.some((turn) => turn.id === id)) return;
        if (!this.isThreadBound && this.threadId) {
            this.isThreadBound = true;
            this.options.onSessionBound(this.threadId);
            this.options.lifecycle({ phase: 'sessionIdentified', agentSessionId: this.threadId });
        }
        this.turnCount += 1;
        this.options.apply([
            {
                op: 'state',
                state: {
                    turns: [
                        ...snapshot.turns,
                        { id, status: 'running' as const, startedAt: Date.now() },
                    ].slice(-MAX_TRACKED_TURNS),
                    activeTurnId: id,
                    plan: null,
                },
            },
        ]);
        this.options.lifecycle({
            phase: 'turnStarted',
            agentSessionId: this.threadId,
            agentTurnId: id,
        });
    }

    private finishTurn(turn: Json): void {
        const turnId = stringField(turn.id);
        const backgrounded = turnId
            ? this.tasks.onTurnFinished(clip(turnId, 200))
            : new Set<string>();
        const snapshot = this.options.read();
        const finished = finishedTurnOperations(
            snapshot,
            turn,
            (requestId, finishedTurnId) => {
                const pending = this.pending.get(requestId);
                if (pending?.turnId !== undefined && pending.turnId !== finishedTurnId) return true;
                this.pending.delete(requestId);
                return false;
            },
            backgrounded,
        );
        if (!finished) return;
        const { id, status, durationMs, operations } = finished;
        /**
         * Compaction runs as its own turn; a turn that ended without completing it must not leave the Chat compacting.
         */
        if (snapshot.operation === 'compacting')
            operations.push({ op: 'state', state: { operation: null } });
        this.options.apply(operations);
        this.options.onTurnFinished(status, durationMs);
        this.options.lifecycle(
            status === 'failed'
                ? {
                      phase: 'turnFailed',
                      agentSessionId: this.threadId,
                      agentTurnId: id,
                      agentFailure: 'provider_failed',
                  }
                : { phase: 'turnFinished', agentSessionId: this.threadId, agentTurnId: id },
        );
    }

    private onNotification(method: string, parameters: Json): void {
        const threadId = stringField(parameters.threadId);
        /**
         * Server requests of a subagent are answered through the Chat like its own, so their resolution is too.
         */
        if (method !== 'serverRequest/resolved' && this.tasks.isOtherThread(threadId)) {
            this.tasks.onChildNotification(threadId, method, parameters);
            return;
        }
        const turnId = stringField(parameters.turnId);
        switch (method) {
            case 'thread/started': {
                this.tasks.onThreadStarted(parameters.thread);
                return;
            }
            case 'turn/started': {
                const turn = isRecord(parameters.turn) ? parameters.turn : undefined;
                const id = stringField(turn?.id);
                if (id) this.beginTurn(id);
                return;
            }
            case 'turn/completed': {
                if (isRecord(parameters.turn)) this.finishTurn(parameters.turn);
                return;
            }
            case 'item/started':
            case 'item/completed': {
                this.onItem(parameters.item, turnId, method === 'item/started');
                return;
            }
            case 'item/agentMessage/delta':
            case 'item/reasoning/summaryTextDelta': {
                this.appendDelta(parameters.itemId, parameters.delta);
                return;
            }
            case 'item/commandExecution/outputDelta': {
                this.appendDelta(parameters.itemId, parameters.delta);
                this.tasks.onCommandOutput(parameters.itemId, parameters.delta);
                return;
            }
            case 'item/reasoning/summaryPartAdded': {
                if (typeof parameters.summaryIndex === 'number' && parameters.summaryIndex > 0)
                    this.appendDelta(parameters.itemId, '\n\n');
                return;
            }
            case 'turn/plan/updated': {
                this.options.apply([
                    { op: 'state', state: { plan: mapCodexPlan(parameters, turnId) } },
                ]);
                return;
            }
            case 'thread/tokenUsage/updated': {
                const usage = mapCodexUsage(parameters, this.options.read().model);
                if (usage) this.options.apply([{ op: 'state', state: { usage } }]);
                return;
            }
            case 'error': {
                this.options.apply([
                    { op: 'upsertItem', item: mapCodexErrorNotice(parameters, turnId) },
                ]);
                return;
            }
            case 'serverRequest/resolved': {
                const transportId = parameters.requestId;
                for (const [key, pending] of this.pending)
                    if (pending.transportId === transportId) this.settleRequest(key);
                return;
            }
            default: {
                // Account, MCP startup, and warning notifications are not conversation content.
            }
        }
    }

    private onItem(raw: unknown, turnId: string | undefined, isStarted: boolean): void {
        const mapped = mapCodexItem(raw, turnId, isStarted);
        const item = mapped && this.deliveries.apply(this.thumbnails.apply(mapped, raw), raw);
        const operations: AgentChatPatchOperation[] = item ? [{ op: 'upsertItem', item }] : [];
        const type = isRecord(raw) ? raw.type : undefined;
        if (type === 'contextCompaction')
            operations.push({
                op: 'state',
                state: { operation: isStarted ? 'compacting' : null },
            });
        if (operations.length > 0) this.options.apply(operations);
        if (!isRecord(raw)) return;
        switch (type) {
            case 'contextCompaction': {
                this.options.lifecycle({
                    phase: isStarted ? 'compactionStarted' : 'compactionFinished',
                });
                break;
            }
            case 'commandExecution': {
                this.tasks.onCommandItem(raw, turnId, isStarted);
                break;
            }
            case 'collabAgentToolCall':
            case 'subAgentActivity': {
                this.tasks.onAgentItem(raw);
                // No default
                break;
            }
        }
    }

    private appendDelta(itemId: unknown, delta: unknown): void {
        if (typeof itemId !== 'string' || typeof delta !== 'string' || !delta) return;
        this.options.apply([
            {
                op: 'appendText',
                itemId: clip(itemId, 200),
                delta: clip(delta, MAX_AGENT_CHAT_TEXT_LENGTH),
            },
        ]);
    }

    private onServerRequest(request: JsonRpcServerRequest): void {
        const connection = this.connection;
        if (!connection) return;
        const kind = codexRequestKind(request.method);
        if (!kind) {
            this.rejectedRequests += 1;
            this.options.onProtocolRejected('unsupportedRequest', request.method);
            /**
             * Every server request must be answered or the turn blocks. MCP elicitation has a protocol-level decline;
             * everything else gets a JSON-RPC error.
             */
            if (request.method === 'mcpServer/elicitation/request')
                connection.respond(request.id, { action: 'decline', content: null, _meta: null });
            else
                connection.respondError(
                    request.id,
                    -32601,
                    'Caxri Chat does not support this request',
                );
            return;
        }
        const key = codexRequestKey(request.params);
        if (!key) {
            this.rejectedRequests += 1;
            this.options.onProtocolRejected('unkeyedRequest', request.method);
            connection.respondError(request.id, -32602, 'Request is missing its item id');
            return;
        }
        const turnId = stringField(request.params.turnId);
        const isNew = !this.pending.has(key);
        this.pending.set(key, {
            transportId: request.id,
            kind,
            ...(turnId && { turnId: clip(turnId, 200) }),
        });
        const mapped: AgentChatRequest = mapCodexRequest(kind, key, request.params);
        const { requests } = this.options.read();
        this.options.apply([
            {
                op: 'state',
                state: {
                    requests: [...requests.filter((existing) => existing.id !== key), mapped].slice(
                        -20,
                    ),
                },
            },
        ]);
        if (isNew)
            this.options.lifecycle({
                phase: 'attentionRequested',
                agentSessionId: this.threadId,
                agentTurnId: turnId,
                agentToolUseId: key,
            });
    }

    private settleRequest(key: string): void {
        if (!this.pending.delete(key)) return;
        const { requests } = this.options.read();
        this.options.apply([
            { op: 'state', state: { requests: requests.filter((request) => request.id !== key) } },
        ]);
        this.options.lifecycle({
            phase: 'attentionResolved',
            agentSessionId: this.threadId,
            agentToolUseId: key,
        });
    }

    private onEnd(end: ChatProcessEnd): void {
        const snapshot = this.options.read();
        const { activeTurnId } = snapshot;
        const operations = endedSessionOperations(snapshot);
        const unanswered = this.pending.keys().toArray();
        this.pending.clear();
        this.options.apply(operations);
        this.tasks.end();
        /**
         * The process took its requests with it; resolve their attention so the Session stops waiting on them.
         */
        for (const key of unanswered)
            this.options.lifecycle({
                phase: 'attentionResolved',
                agentSessionId: this.threadId,
                agentToolUseId: key,
            });
        const counters = this.connection?.counters;
        this.options.onExit({
            end,
            requested: this.requested,
            ...(activeTurnId && { activeTurnId }),
            turns: this.turnCount,
            serverRequests: counters?.serverRequests ?? 0,
            rejectedRequests: this.rejectedRequests,
            droppedFrames: counters?.droppedFrames ?? 0,
        });
    }

    private async open(): Promise<'resumed' | 'started'> {
        let spawnFailure: ChatProcessEnd | undefined;
        const connection = new JsonRpcConnection({
            label: 'Codex app-server',
            executable: this.options.executable,
            args: [...this.settings.rootArgs, 'app-server', '--listen', 'stdio://'],
            cwd: this.options.cwd,
            environment: this.options.environment,
            spawnProcess: this.options.spawnProcess,
            handlers: {
                onNotification: (method, parameters) => this.onNotification(method, parameters),
                onServerRequest: (request) => this.onServerRequest(request),
                onEnd: (end) => {
                    if (end.reason === 'spawnFailed') spawnFailure = end;
                    this.onEnd(end);
                },
            },
        });
        this.connection = connection;
        await initializeCodexConnection(connection, this.options.clientVersion, () => spawnFailure);
        const opened = await openCodexThread(connection, {
            cwd: this.options.cwd,
            settings: this.settings,
            ...(this.threadId && { threadId: this.threadId }),
        });
        if (opened.outcome === 'resumed') {
            this.loadHistory(opened.thread, opened.model);
            this.models.reportOpened(opened.effort);
            return 'resumed';
        }
        this.threadId = opened.threadId;
        if (opened.model)
            this.options.apply([{ op: 'state', state: { model: clip(opened.model, 200) } }]);
        this.models.reportOpened(opened.effort);
        return 'started';
    }

    get isOpen(): boolean {
        return this.connection?.isOpen ?? false;
    }

    get pid(): number | undefined {
        return this.connection?.pid;
    }

    /**
     * Spawns the provider, completes the handshake, and opens the thread. Resolves once the Chat can accept input.
     */
    async start(): Promise<'resumed' | 'started'> {
        const outcome = await this.open();
        // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- Listing needs the connection `open` creates, and the default effort reads the thread it reported.
        const modelState = await this.models.load(this.requireConnection());
        this.options.apply([{ op: 'state', state: { commands: CODEX_COMMANDS, ...modelState } }]);
        return outcome;
    }

    async send(
        message: Omit<AgentChatMessageInput, 'delivery'>,
        options: ChatInputOptions = {},
    ): Promise<void> {
        const connection = this.requireConnection();
        const clientUserMessageId = randomUUID();
        const input = codexUserInput(message);
        this.thumbnails.remember(clientUserMessageId, message);
        if (options.delivery) this.deliveries.remember(clientUserMessageId, options.delivery);
        const { activeTurnId } = this.options.read();
        if (activeTurnId && options.delivery === 'steered') {
            try {
                await connection.request(
                    'turn/steer',
                    {
                        threadId: this.threadId,
                        input,
                        expectedTurnId: activeTurnId,
                        clientUserMessageId,
                    },
                    TURN_REQUEST_TIMEOUT_MS,
                );
                return;
            } catch (error) {
                /**
                 * The turn can finish between reading `activeTurnId` and the steer arriving; Codex then rejects the
                 * precondition and the message starts the next turn instead of being lost. It was not steered after
                 * all, so its echo carries no marker.
                 */
                if (!(error instanceof JsonRpcRequestError)) throw error;
                if (!isSteerTargetGone(error))
                    throw new CaxriError(
                        'CONFLICT',
                        'Codex cannot add this message to the running turn',
                    );
                this.deliveries.forget(clientUserMessageId);
            }
        }
        const result = await this.models.startTurn(
            connection,
            { threadId: this.threadId, input, summary: 'detailed', clientUserMessageId },
            TURN_REQUEST_TIMEOUT_MS,
        );
        const turn = isRecord(result) && isRecord(result.turn) ? result.turn : undefined;
        const turnId = stringField(turn?.id);
        // `turn/started` normally arrives first; the response covers a provider that reorders them.
        if (turnId) this.beginTurn(turnId);
    }

    async runCommand(name: string): Promise<void> {
        if (name !== 'compact')
            throw new CaxriError('VALIDATION', `/${name} is not available in Codex Chat`);
        if (this.options.read().activeTurnId)
            throw new CaxriError(
                'CONFLICT',
                'Wait for the current turn to finish before compacting',
            );
        const connection = this.requireConnection();
        // Codex runs compaction as its own turn, so the usual turn and `contextCompaction` events report it.
        await connection.request(
            'thread/compact/start',
            { threadId: this.threadId },
            TURN_REQUEST_TIMEOUT_MS,
        );
    }

    configure(change: AgentChatModelChange): Promise<void> {
        this.requireConnection();
        this.models.configure(change);
        return Promise.resolve();
    }

    async interrupt(): Promise<void> {
        const connection = this.requireConnection();
        const { activeTurnId } = this.options.read();
        if (!activeTurnId) return;
        try {
            await connection.request(
                'turn/interrupt',
                { threadId: this.threadId, turnId: activeTurnId },
                INTERRUPT_TIMEOUT_MS,
            );
        } catch (error) {
            if (error instanceof CaxriError && error.code === 'TIMEOUT') {
                await this.close();
                return;
            }
            // The turn already ended between the read and the request; `turn/completed` settles the projection.
        }
    }

    async stopTask(taskId: string): Promise<void> {
        this.requireConnection();
        await this.tasks.stopTask(taskId);
    }

    async readTaskHistory(taskId: string): Promise<ChatTaskHistory | undefined> {
        if (!this.connection?.isOpen || !this.threadId) return undefined;
        return this.tasks.readTaskHistory(taskId);
    }

    respond(requestId: string, response: AgentChatResponse): void {
        const connection = this.requireConnection();
        const pending = this.pending.get(requestId);
        if (!pending) throw new CaxriError('CONFLICT', 'This request is no longer pending');
        if (pending.kind === 'question') {
            const answers = questionAnswers(response);
            connection.respond(pending.transportId, {
                answers: Object.fromEntries(
                    Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
                ),
            });
            const answered = answeredNotice(
                this.options.read().requests.find((request) => request.id === requestId),
                pending.turnId,
                answers,
            );
            if (answered) this.options.apply([{ op: 'upsertItem', item: answered }]);
        } else {
            if (response.kind !== 'decision')
                throw new CaxriError('VALIDATION', 'An approval needs a decision');
            connection.respond(pending.transportId, { decision: response.decision });
        }
        this.settleRequest(requestId);
    }

    async close(): Promise<void> {
        this.requested = true;
        await this.connection?.close();
    }
}

export const codexChatDriver: AgentChatDriver = {
    create: (host) => new CodexChatSession(host),
};
