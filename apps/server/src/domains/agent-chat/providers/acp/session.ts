import type {
    AgentChatMessageInput,
    AgentChatModelChange,
    AgentChatPatchOperation,
    AgentChatPermissionMode,
    AgentChatResponse,
    AgentChatSnapshot,
    AgentChatTurn,
    AgentProvider,
} from '@caxri/protocol';
import { CaxriError, MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import {
    clip,
    closeDanglingItem,
    endedSessionOperations,
    isRecord,
    slashCommandPrompt,
    startedTurnOperation,
    stringField,
} from '../../chat-items';
import { chatPermissionState } from '../../chat-permissions';
import type {
    AgentChatProviderSession,
    AgentChatSessionHost,
    ChatFork,
    ChatForkTarget,
    ChatInputOptions,
    ChatProcessEnd,
    ChatRewindTarget,
    ChatTaskHistory,
} from '../../chat-provider';
import { AgentChatStartError, turnNotSteerableError } from '../../chat-provider';
import { withCacheRewriteEstimate } from '../../chat-usage';
import type { JsonRpcServerRequest } from '../../json-rpc-connection';
import { JsonRpcConnection, JsonRpcRequestError } from '../../json-rpc-connection';
import { queuedPromptUuid } from '../../queued-prompt-uuid';
import { ChatShellToolSignals } from '../../worktree/shell-tool-signals';
import type { AcpToolCall, AcpToolPresentation } from './items';
import type { AcpQuestionDialect } from './requests';
import { AcpRequestBroker } from './requests';
import {
    failAcpStart,
    initializeAcpConnection,
    newAcpSession,
    SESSION_OPEN_TIMEOUT_MS,
} from './session-open';
import { AcpUpdates, stopReasonStatus } from './updates';

export const TURN_REQUEST_TIMEOUT_MS = 30_000;
/**
 * `session/cancel` is a notification; the running prompt answers `cancelled` once the turn stops. A provider that never
 * does is stopped instead so the Chat cannot stay stuck in a running turn.
 */
const INTERRUPT_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

export interface AcpActiveTurn {
    id: string;
    startedAt: number;
    isCompaction: boolean;
    /**
     * Settle every `interrupt()` waiting for the cancelled prompt to answer; a repeated Stop adds another.
     */
    onFinished: Array<() => void>;
}

/**
 * What differs between ACP agents at the level a session needs before it opens: its name in errors, its tool titles,
 * and its extensions to the update and request streams.
 */
export interface AcpDialect {
    provider: AgentProvider;
    /**
     * The agent's name in errors, e.g. `Grok Build`.
     */
    label: string;
    presentation: AcpToolPresentation;
    questions?: AcpQuestionDialect;
    displayText?: (content: Json | undefined) => string | undefined;
    configState?: (configOptions: unknown) => Partial<AgentChatSnapshot> | undefined;
    /**
     * The status a replayed turn the agent did not mark finished gets; see {@link AcpUpdates.endReplay}.
     */
    settledReplayTurns: AgentChatTurn['status'];
}

/**
 * One live ACP (Agent Client Protocol) agent process bound to one Chat Terminal. It translates session updates into
 * projection operations and lifecycle events; the owning service persists, broadcasts, and serializes them. A provider
 * subclass supplies its launch arguments, the state it opens with, and its extensions. See `docs/agent-chat.md`.
 *
 * @see https://agentclientprotocol.com/protocol/overview
 */
export abstract class AcpChatSession implements AgentChatProviderSession {
    private isSessionBound: boolean;

    private requested = false;

    private turnCount = 0;

    private rejectedRequests = 0;

    private readonly shellTools: ChatShellToolSignals;

    protected connection: JsonRpcConnection | undefined;

    /**
     * The conversation's id: preset by an agent that accepts a client-chosen id, otherwise the one `session/new`
     * returned. Undefined only while a new conversation opens.
     */
    protected sessionId: string | undefined;

    protected readonly updates: AcpUpdates;

    protected readonly requests: AcpRequestBroker;

    protected activeTurn: AcpActiveTurn | undefined;

    protected contextWindow: number | undefined;

    constructor(
        protected readonly options: AgentChatSessionHost,
        protected readonly dialect: AcpDialect,
        sessionId: string | undefined,
    ) {
        this.sessionId = sessionId;
        this.isSessionBound = Boolean(options.agentSessionId);
        this.shellTools = new ChatShellToolSignals((event) => options.lifecycle(event));
        this.updates = new AcpUpdates({
            apply: (operations) => options.apply(operations),
            activeTurnId: () => this.activeTurn?.id,
            presentation: dialect.presentation,
            ...(dialect.displayText && { displayText: dialect.displayText }),
            ...(dialect.configState && { configState: dialect.configState }),
            onToolCall: (call) => this.onToolCall(call),
        });
        this.requests = new AcpRequestBroker({
            host: options,
            sessionId: () => this.sessionId ?? '',
            presentation: dialect.presentation,
            ...(dialect.questions && { questions: dialect.questions }),
            onDeclined: (key) => this.updates.decline(key),
        });
    }

    /**
     * Feeds the Workbench Root's worktree attribution from shell tool calls; see {@link ChatShellToolSignals}.
     */
    private onToolCall(call: AcpToolCall): void {
        if (call.kind !== 'execute') return;
        if (call.status === 'completed') this.shellTools.ended(call.id, 'finished');
        else if (call.status === 'failed') this.shellTools.ended(call.id, 'failed');
        else this.shellTools.started(call.id, this.dialect.presentation.shellCommand(call));
    }

    private onNotification(method: string, parameters: Json): void {
        const target = stringField(parameters.sessionId);
        if (target && this.sessionId && target !== this.sessionId) return;
        const update = isRecord(parameters.update) ? parameters.update : undefined;
        if (!update) return;
        const meta = isRecord(parameters._meta) ? parameters._meta : undefined;
        this.updates.setEventTime(meta?.agentTimestampMs);
        if (method === 'session/update') this.updates.onSessionUpdate(update);
        else this.onExtensionNotification?.(method, update);
    }

    private onServerRequest(request: JsonRpcServerRequest): void {
        const connection = this.connection;
        if (!connection) return;
        if (this.onExtensionRequest?.(connection, request)) return;
        if (request.method !== 'session/request_permission') {
            this.rejectedRequests += 1;
            this.options.onProtocolRejected('unsupportedRequest', request.method);
            connection.respondError(request.id, -32601, 'Caxri Chat does not support this request');
            return;
        }
        const toolCall = isRecord(request.params.toolCall) ? request.params.toolCall : {};
        const call = this.updates.upsertToolCall(toolCall);
        if (!call) {
            this.rejectedRequests += 1;
            this.options.onProtocolRejected('unkeyedRequest', request.method);
            connection.respond(request.id, { outcome: { outcome: 'cancelled' } });
            return;
        }
        this.requests.ask(
            connection,
            request.id,
            call,
            request.params.options,
            this.activeTurn?.id,
        );
    }

    private beginTurn(turnId: string, isCompaction: boolean): void {
        const sessionId = this.requireSessionId();
        if (!this.isSessionBound) {
            this.isSessionBound = true;
            this.options.onSessionBound(sessionId);
            this.options.lifecycle({ phase: 'sessionIdentified', agentSessionId: sessionId });
        }
        this.turnCount += 1;
        this.activeTurn = { id: turnId, startedAt: Date.now(), isCompaction, onFinished: [] };
        const snapshot = this.options.read();
        this.options.apply([startedTurnOperation(snapshot, turnId)]);
        this.options.lifecycle({
            phase: 'turnStarted',
            agentSessionId: sessionId,
            agentTurnId: turnId,
        });
    }

    private finishTurn(
        turnId: string,
        status: AgentChatTurn['status'],
        details: { result?: unknown; error?: string } = {},
    ): void {
        const turn = this.activeTurn;
        if (turn?.id !== turnId) return;
        this.activeTurn = undefined;
        this.shellTools.clear();
        this.updates.closeStreaming();
        const durationMs = Date.now() - turn.startedAt;
        const snapshot = this.options.read();
        const operations: AgentChatPatchOperation[] = [];
        for (const item of snapshot.items) {
            if (item.turnId !== turnId) continue;
            const closed = closeDanglingItem(item);
            if (closed) operations.push({ op: 'upsertItem', item: closed });
        }
        if (details.error)
            operations.push({
                op: 'upsertItem',
                item: {
                    id: `${turnId}:error`,
                    turnId,
                    type: 'notice',
                    kind: 'error',
                    message: clip(details.error, 2_000),
                },
            });
        if (status === 'completed' && turn.isCompaction)
            operations.push({
                op: 'upsertItem',
                item: { id: `${turnId}:compacted`, turnId, type: 'notice', kind: 'compacted' },
            });
        const reported = this.usage(details.result);
        const usage = reported && withCacheRewriteEstimate(reported, snapshot.model);
        operations.push({
            op: 'state',
            state: {
                turns: snapshot.turns.map((existing) =>
                    existing.id === turnId ? { ...existing, status, durationMs } : existing,
                ),
                activeTurnId: null,
                ...(usage && { usage }),
            },
        });
        this.options.apply(operations);
        this.requests.settleTurn(turnId);
        this.options.onTurnFinished(status, durationMs, turnId);
        const agentSessionId = this.sessionId ?? '';
        this.options.lifecycle(
            status === 'failed'
                ? {
                      phase: 'turnFailed',
                      agentSessionId,
                      agentTurnId: turnId,
                      agentFailure: 'provider_failed',
                  }
                : { phase: 'turnFinished', agentSessionId, agentTurnId: turnId },
        );
        if (status === 'completed' && turn.isCompaction)
            this.options.lifecycle({ phase: 'compactionFinished' });
        for (const settle of turn.onFinished) settle();
    }

    private async awaitPrompt(
        connection: JsonRpcConnection,
        turnId: string,
        text: string,
    ): Promise<void> {
        let result: unknown;
        const meta = this.promptMeta?.(turnId);
        try {
            result = await connection.request('session/prompt', {
                sessionId: this.sessionId,
                prompt: [{ type: 'text', text }],
                ...(meta && { _meta: meta }),
            });
        } catch (error) {
            // A stopped process already closed the turn through `onEnd`; a provider error fails it visibly.
            if (error instanceof JsonRpcRequestError)
                this.finishTurn(turnId, 'failed', { error: error.message });
            return;
        }
        this.finishTurn(
            turnId,
            stopReasonStatus(isRecord(result) ? result.stopReason : undefined),
            { result },
        );
    }

    private onEnd(end: ChatProcessEnd): void {
        const snapshot = this.options.read();
        const { activeTurnId } = snapshot;
        const turn = this.activeTurn;
        this.activeTurn = undefined;
        this.updates.dropStreaming();
        this.shellTools.clear();
        const unanswered = this.requests.drain();
        this.options.apply(endedSessionOperations(snapshot));
        this.requests.resolveAttention(unanswered);
        const waiting = turn?.onFinished ?? [];
        for (const settle of waiting) settle();
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

    /**
     * Replays a bound conversation through `session/load`, which streams the history as session updates before it
     * answers, then applies it as one reset.
     */
    private async load(connection: JsonRpcConnection): Promise<unknown> {
        this.updates.beginReplay();
        let result: unknown;
        try {
            result = await connection.request(
                'session/load',
                { ...this.sessionParameters(), sessionId: this.sessionId },
                SESSION_OPEN_TIMEOUT_MS,
            );
        } catch {
            this.updates.endReplay(false);
            return failAcpStart(
                connection,
                new AgentChatStartError(
                    'resume_failed',
                    `${this.dialect.label} could not resume this conversation`,
                ),
            );
        }
        this.options.apply(this.updates.endReplay(true, this.dialect.settledReplayTurns));
        return result;
    }

    private async open(): Promise<'resumed' | 'started'> {
        const { args, permissionMode } = this.launchArguments();
        let spawnFailure: ChatProcessEnd | undefined;
        const connection = new JsonRpcConnection({
            label: this.dialect.label,
            jsonrpc: true,
            executable: this.options.executable,
            args,
            cwd: this.options.cwd,
            environment: this.options.environment,
            spawnProcess: this.options.spawnProcess,
            processGroups: this.options.processGroups,
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
        const initialized = await initializeAcpConnection(
            connection,
            this.dialect.label,
            this.options.clientVersion,
            () => spawnFailure,
        );
        this.onInitialized?.(initialized);
        const outcome = this.isSessionBound ? 'resumed' : 'started';
        let opened: unknown;
        if (this.isSessionBound) opened = await this.load(connection);
        else {
            const created = await newAcpSession(
                connection,
                this.dialect.label,
                this.newSessionParameters(),
                this.sessionId,
            );
            this.sessionId = created.sessionId;
            opened = created;
        }
        this.options.apply([
            {
                op: 'state',
                state: {
                    ...this.openingState(opened),
                    ...chatPermissionState(this.dialect.provider, permissionMode, false),
                },
            },
        ]);
        return outcome;
    }

    /**
     * The `executable` arguments the agent runs with, and the permission level they give it.
     */
    protected abstract launchArguments(): {
        args: string[];
        permissionMode: AgentChatPermissionMode | undefined;
    };

    /**
     * Parameters shared by `session/new` and `session/load`.
     */
    protected sessionParameters(): Json {
        return { cwd: this.options.cwd, mcpServers: [] };
    }

    /**
     * Parameters for `session/new`; an agent that adopts a client-chosen id reads it here.
     */
    protected newSessionParameters(): Json {
        return this.sessionParameters();
    }

    /**
     * The `_meta` a `session/prompt` carries, if any.
     */
    protected promptMeta?(turnId: string): Json | undefined;

    /**
     * Applies what the agent's `initialize` result reports, before the conversation opens. Without it, nothing beyond
     * the protocol version is read.
     */
    protected onInitialized?(initialized: Json): void;

    /**
     * The Chat state a `session/new` or `session/load` result reports: the model, its choices, and the effort.
     */
    protected abstract openingState(opened: unknown): Partial<AgentChatSnapshot>;

    /**
     * Context usage from a `session/prompt` result.
     */
    protected abstract usage(result: unknown): AgentChatSnapshot['usage'];

    /**
     * A notification outside `session/update`, such as Grok Build's `_x.ai/session_notification`. Without it, every
     * such notification is ignored: model lists, settings, announcements, and MCP status are process-wide, not
     * conversation content.
     */
    protected onExtensionNotification?(method: string, update: Json): void;

    /**
     * A server request outside `session/request_permission`; returns whether the dialect handled it.
     */
    protected onExtensionRequest?(
        connection: JsonRpcConnection,
        request: JsonRpcServerRequest,
    ): boolean;

    /**
     * Adds a message to the running turn. An agent without it refuses a mid-turn message, so the Chat queues it
     * instead.
     */
    protected steer?(
        connection: JsonRpcConnection,
        turn: AcpActiveTurn,
        message: Omit<AgentChatMessageInput, 'delivery'>,
        options: ChatInputOptions | undefined,
    ): Promise<'steered' | 'turnEnded'>;

    protected requireConnection(): JsonRpcConnection {
        if (!this.connection?.isOpen)
            throw new CaxriError('UNAVAILABLE', `${this.dialect.label} Chat is not running`);
        return this.connection;
    }

    protected requireSessionId(): string {
        if (!this.sessionId)
            throw new CaxriError('UNAVAILABLE', `${this.dialect.label} Chat is not running`);
        return this.sessionId;
    }

    /**
     * Starts a turn with `text`. The prompt request stays open for the whole turn and answers with its stop reason.
     */
    protected prompt(text: string, isCompaction: boolean, options: ChatInputOptions = {}): void {
        const connection = this.requireConnection();
        const turnId = queuedPromptUuid(options.delivery);
        this.beginTurn(turnId, isCompaction);
        this.options.apply([
            {
                op: 'upsertItem',
                item: {
                    id: `${turnId}:user`,
                    turnId,
                    type: 'userMessage',
                    text: clip(text, MAX_AGENT_CHAT_TEXT_LENGTH),
                    ...(options.delivery && { delivery: options.delivery }),
                },
            },
        ]);
        void this.awaitPrompt(connection, turnId, text);
    }

    get isOpen(): boolean {
        return this.connection?.isOpen ?? false;
    }

    start(): Promise<'resumed' | 'started'> {
        return this.open();
    }

    async send(
        message: Omit<AgentChatMessageInput, 'delivery'>,
        options?: ChatInputOptions,
    ): Promise<void> {
        if (message.images && message.images.length > 0)
            throw new CaxriError('VALIDATION', `${this.dialect.label} Chat does not accept images`);
        const connection = this.requireConnection();
        const turn = this.activeTurn;
        // A turn that ended while the message was in flight cannot take it; the message starts the next turn instead.
        // The service queues a message the running turn cannot take, behind that turn.
        if (turn && !this.steer)
            throw turnNotSteerableError(`${this.dialect.label} cannot add to a running turn`);
        if (turn && (await this.steer?.(connection, turn, message, options)) === 'steered') return;
        this.prompt(message.text, false, options);
    }

    runCommand(
        name: string,
        arguments_: string | undefined,
        options?: ChatInputOptions,
    ): Promise<void> {
        if (this.activeTurn)
            return Promise.reject(
                new CaxriError(
                    'CONFLICT',
                    'Wait for the current turn to finish before running a command',
                ),
            );
        this.prompt(slashCommandPrompt(name, arguments_), name === 'compact', options);
        return Promise.resolve();
    }

    /**
     * ACP Chats project no background tasks, so there is never one to stop.
     */
    stopTask(): Promise<void> {
        return Promise.reject(new CaxriError('CONFLICT', 'This task is no longer running'));
    }

    readTaskHistory(): Promise<ChatTaskHistory | undefined> {
        return Promise.resolve(undefined);
    }

    /**
     * Rewinding needs a provider extension; a dialect without one refuses, and the catalog's `capabilities.chatRewind`
     * keeps the action hidden.
     */
    abstract rewind(target: ChatRewindTarget): Promise<undefined>;

    abstract fork(target: ChatForkTarget | undefined): Promise<ChatFork>;

    async interrupt(): Promise<void> {
        const connection = this.requireConnection();
        const turn = this.activeTurn;
        if (!turn) return;
        const finished = new Promise<boolean>((resolve) => {
            turn.onFinished.push(() => resolve(true));
            setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS).unref();
        });
        // ACP requires the client to answer the turn's pending permission requests `cancelled` once it cancels.
        this.requests.cancelTurn(connection, turn.id);
        connection.notify('session/cancel', { sessionId: this.sessionId });
        // Only a turn that is still running is stuck; a later Stop or the turn ending on its own settles this one.
        if (!(await finished) && this.activeTurn === turn) await this.close();
    }

    abstract configure(change: AgentChatModelChange): Promise<void>;

    respond(requestId: string, response: AgentChatResponse): void {
        this.requests.respond(this.requireConnection(), requestId, response);
    }

    async close(): Promise<void> {
        this.requested = true;
        await this.connection?.close();
    }
}
