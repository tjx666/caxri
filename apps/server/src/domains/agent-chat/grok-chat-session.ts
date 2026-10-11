import { randomUUID } from 'node:crypto';

import type {
    AgentChatMessageInput,
    AgentChatModelChange,
    AgentChatPatchOperation,
    AgentChatTurn,
} from '@caxri/protocol';
import { CaxriError, MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import {
    clip,
    closeDanglingItem,
    endedSessionOperations,
    isRecord,
    MAX_TRACKED_TURNS,
    slashCommandPrompt,
    stringField,
} from './chat-items';
import type {
    AgentChatDriver,
    AgentChatProviderSession,
    AgentChatResponse,
    AgentChatSessionHost,
    ChatForkTarget,
    ChatInputOptions,
    ChatProcessEnd,
    ChatRewindTarget,
    ChatTaskHistory,
} from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import {
    grokCommands,
    grokContextWindow,
    grokModels,
    grokModelState,
    grokUsage,
} from './grok-items';
import { GrokRequestBroker } from './grok-requests';
import { forkGrokSession, rewindGrokSession } from './grok-rewind';
import {
    failGrokStart,
    grokSessionParameters,
    initializeGrokConnection,
    newGrokSession,
    SESSION_OPEN_TIMEOUT_MS,
} from './grok-session-open';
import { GrokUpdates, stopReasonStatus } from './grok-updates';
import type { JsonRpcServerRequest } from './json-rpc-connection';
import { JsonRpcConnection, JsonRpcRequestError } from './json-rpc-connection';
import { grokChatSettings } from './launch-settings';

const TURN_REQUEST_TIMEOUT_MS = 30_000;
/**
 * `session/cancel` is a notification; the running prompt answers `cancelled` once the turn stops. A provider that never
 * does is stopped instead so the Chat cannot stay stuck in a running turn.
 */
const INTERRUPT_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

interface ActiveTurn {
    id: string;
    startedAt: number;
    isCompaction: boolean;
    /**
     * Settle every `interrupt()` waiting for the cancelled prompt to answer; a repeated Stop adds another.
     */
    onFinished: Array<() => void>;
}

/**
 * One live `grok agent stdio` process bound to one Chat Terminal, speaking ACP (Agent Client Protocol). It translates
 * session updates into projection operations and lifecycle events; the owning service persists, broadcasts, and
 * serializes them. See `docs/agent-chat.md`.
 *
 * @see https://agentclientprotocol.com/protocol/overview
 */
class GrokChatSession implements AgentChatProviderSession {
    private connection: JsonRpcConnection | undefined;

    /**
     * Grok Build accepts a client-chosen id through `session/new`'s `_meta.sessionId`, so the id is known before the
     * first turn, as with Claude Code's preset `--session-id`.
     */
    private readonly sessionId: string;

    private isSessionBound: boolean;

    private readonly updates: GrokUpdates;

    private readonly requests: GrokRequestBroker;

    private activeTurn: ActiveTurn | undefined;

    private contextWindow: number | undefined;

    /**
     * The `models` record Grok Build returned when the conversation opened, for the context window of a switched model.
     */
    private listedModels: unknown;

    private requested = false;

    private turnCount = 0;

    private rejectedRequests = 0;

    constructor(private readonly options: AgentChatSessionHost) {
        this.sessionId = options.agentSessionId ?? randomUUID();
        this.isSessionBound = Boolean(options.agentSessionId);
        this.updates = new GrokUpdates({
            apply: (operations) => options.apply(operations),
            activeTurnId: () => this.activeTurn?.id,
            onInteractionResolved: (key) => this.requests.settle(key),
        });
        this.requests = new GrokRequestBroker({
            host: options,
            sessionId: this.sessionId,
            onDeclined: (key) => this.updates.decline(key),
        });
    }

    private requireConnection(): JsonRpcConnection {
        if (!this.connection?.isOpen)
            throw new CaxriError('UNAVAILABLE', 'Grok Build Chat is not running');
        return this.connection;
    }

    private onNotification(method: string, parameters: Json): void {
        if (stringField(parameters.sessionId) && parameters.sessionId !== this.sessionId) return;
        const update = isRecord(parameters.update) ? parameters.update : undefined;
        if (!update) return;
        const meta = isRecord(parameters._meta) ? parameters._meta : undefined;
        this.updates.setEventTime(meta?.agentTimestampMs);
        if (method === 'session/update') this.updates.onSessionUpdate(update);
        else if (method === '_x.ai/session_notification' || method === '_x.ai/session/update')
            this.updates.onExtensionUpdate(update);
        // Model lists, settings, announcements, and MCP status are process-wide, not conversation content.
    }

    private onServerRequest(request: JsonRpcServerRequest): void {
        const connection = this.connection;
        if (!connection) return;
        if (request.method === '_x.ai/ask_user_question') {
            const parameters = request.params;
            this.requests.askQuestion(
                connection,
                request.id,
                clip(stringField(parameters.toolCallId) ?? `question:${request.id}`, 200),
                parameters.questions,
                this.activeTurn?.id,
            );
            return;
        }
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
        if (!this.isSessionBound) {
            this.isSessionBound = true;
            this.options.onSessionBound(this.sessionId);
            this.options.lifecycle({ phase: 'sessionIdentified', agentSessionId: this.sessionId });
        }
        this.turnCount += 1;
        this.activeTurn = { id: turnId, startedAt: Date.now(), isCompaction, onFinished: [] };
        const snapshot = this.options.read();
        this.options.apply([
            {
                op: 'state',
                state: {
                    turns: [
                        ...snapshot.turns,
                        { id: turnId, status: 'running' as const, startedAt: Date.now() },
                    ].slice(-MAX_TRACKED_TURNS),
                    activeTurnId: turnId,
                    plan: null,
                },
            },
        ]);
        this.options.lifecycle({
            phase: 'turnStarted',
            agentSessionId: this.sessionId,
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
        const usage = grokUsage(details.result, this.contextWindow);
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
        this.options.onTurnFinished(status, durationMs);
        this.options.lifecycle(
            status === 'failed'
                ? {
                      phase: 'turnFailed',
                      agentSessionId: this.sessionId,
                      agentTurnId: turnId,
                      agentFailure: 'provider_failed',
                  }
                : { phase: 'turnFinished', agentSessionId: this.sessionId, agentTurnId: turnId },
        );
        if (status === 'completed' && turn.isCompaction)
            this.options.lifecycle({ phase: 'compactionFinished' });
        for (const settle of turn.onFinished) settle();
    }

    /**
     * Starts a turn with `text`. The prompt request stays open for the whole turn and answers with its stop reason.
     */
    private prompt(text: string, isCompaction: boolean, options: ChatInputOptions = {}): void {
        const connection = this.requireConnection();
        const turnId = randomUUID();
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
        // eslint-disable-next-line no-void -- the prompt stays open for the whole turn and reports through finishTurn.
        void this.awaitPrompt(connection, turnId, text);
    }

    private async awaitPrompt(
        connection: JsonRpcConnection,
        turnId: string,
        text: string,
    ): Promise<void> {
        let result: unknown;
        try {
            result = await connection.request('session/prompt', {
                sessionId: this.sessionId,
                prompt: [{ type: 'text', text }],
                _meta: { promptId: turnId },
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
                { ...grokSessionParameters(this.options.cwd), sessionId: this.sessionId },
                SESSION_OPEN_TIMEOUT_MS,
            );
        } catch {
            this.updates.endReplay(false);
            return failGrokStart(
                connection,
                new AgentChatStartError(
                    'resume_failed',
                    'Grok Build could not resume this conversation',
                ),
            );
        }
        this.options.apply(this.updates.endReplay(true));
        return result;
    }

    private async open(): Promise<'resumed' | 'started'> {
        const settings = grokChatSettings(this.options.launch);
        let spawnFailure: ChatProcessEnd | undefined;
        const connection = new JsonRpcConnection({
            label: 'Grok Build',
            jsonrpc: true,
            executable: this.options.executable,
            /**
             * `--no-leader` keeps the agent in this process: Grok Build's `[cli] use_leader` setting would otherwise
             * turn stdio into a bridge to a shared leader whose working directory and lifetime Caxri does not own.
             */
            args: [...settings.rootArgs, 'agent', ...settings.agentArgs, '--no-leader', 'stdio'],
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
        const meta = await initializeGrokConnection(
            connection,
            this.options.clientVersion,
            () => spawnFailure,
        );
        this.options.apply([
            { op: 'state', state: { commands: grokCommands(meta.availableCommands) } },
        ]);
        const outcome = this.isSessionBound ? 'resumed' : 'started';
        const result = this.isSessionBound
            ? await this.load(connection)
            : await newGrokSession(connection, this.sessionId, this.options.cwd);
        const models = isRecord(result) ? result.models : undefined;
        const { model, contextWindow } = grokModelState(models);
        this.listedModels = models;
        this.contextWindow = contextWindow;
        this.options.apply([
            { op: 'state', state: { ...(model && { model }), models: grokModels(models) } },
        ]);
        return outcome;
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
            throw new CaxriError('VALIDATION', 'Grok Build Chat does not accept images');
        const connection = this.requireConnection();
        const turn = this.activeTurn;
        if (turn) {
            try {
                /**
                 * Grok Build queues a second `session/prompt` behind the running turn; its interjection extension is
                 * the equivalent of typing into the TUI mid-turn, so the message reaches the turn that is running.
                 */
                await connection.request(
                    '_x.ai/interject',
                    { sessionId: this.sessionId, text: message.text, interjectionId: randomUUID() },
                    TURN_REQUEST_TIMEOUT_MS,
                );
                // A turn that ended while the interjection was in flight cannot show it; start the next turn instead.
                if (this.activeTurn !== turn) {
                    this.prompt(message.text, false, options);
                    return;
                }
                this.options.apply([
                    {
                        op: 'upsertItem',
                        item: {
                            id: this.updates.nextItemId(turn.id, 'user'),
                            turnId: turn.id,
                            type: 'userMessage',
                            text: clip(message.text, MAX_AGENT_CHAT_TEXT_LENGTH),
                            delivery: 'steered',
                        },
                    },
                ]);
                this.updates.closeStreaming();
                return;
            } catch (error) {
                // The turn can end between the check and the interjection; the message then starts the next turn.
                if (!(error instanceof JsonRpcRequestError)) throw error;
                if (this.activeTurn)
                    throw new CaxriError('CONFLICT', 'Grok Build could not take this message now');
            }
        }
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
     * Grok Build Chat projects no background tasks, so there is never one to stop.
     */
    stopTask(): Promise<void> {
        return Promise.reject(new CaxriError('CONFLICT', 'This task is no longer running'));
    }

    readTaskHistory(): Promise<ChatTaskHistory | undefined> {
        return Promise.resolve(undefined);
    }

    rewind(target: ChatRewindTarget): Promise<undefined> {
        const snapshot = this.options.read();
        return rewindGrokSession(this.requireConnection(), this.sessionId, snapshot, target);
    }

    fork(target: ChatForkTarget): Promise<string> {
        const source = { sessionId: this.sessionId, cwd: this.options.cwd };
        return forkGrokSession(this.requireConnection(), source, this.options.read(), target);
    }

    async restoreFiles(target: ChatRewindTarget): Promise<void> {
        const snapshot = this.options.read();
        await rewindGrokSession(
            this.requireConnection(),
            this.sessionId,
            snapshot,
            target,
            'files',
        );
    }

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

    async configure({ model }: AgentChatModelChange): Promise<void> {
        if (!model) return;
        const result = await this.requireConnection().request(
            'session/set_model',
            { sessionId: this.sessionId, modelId: model.id },
            TURN_REQUEST_TIMEOUT_MS,
        );
        const meta = isRecord(result) && isRecord(result._meta) ? result._meta : undefined;
        if (isRecord(meta?.model) && 'Err' in meta.model)
            throw new CaxriError('UNAVAILABLE', `Grok Build could not switch to ${model.id}`);
        this.contextWindow = grokContextWindow(this.listedModels, model.id);
        this.options.apply([{ op: 'state', state: { model: model.id } }]);
    }

    respond(requestId: string, response: AgentChatResponse): void {
        this.requests.respond(this.requireConnection(), requestId, response);
    }

    async close(): Promise<void> {
        this.requested = true;
        await this.connection?.close();
    }
}

export const grokChatDriver: AgentChatDriver = {
    create: (host) => new GrokChatSession(host),
};
