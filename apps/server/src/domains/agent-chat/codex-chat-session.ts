import type {
    AgentChatGoalChange,
    AgentChatMessageInput,
    AgentChatModelChange,
    AgentChatPatchOperation,
    AgentChatPermission,
    AgentChatResponse,
} from '@caxri/protocol';
import {
    AGENT_CHAT_GOAL_COMMAND,
    CaxriError,
    MAX_AGENT_CHAT_TEXT_LENGTH,
    parseAgentChatGoalArguments,
} from '@caxri/protocol';

import {
    clip,
    endedSessionOperations,
    isRecord,
    startedTurnOperation,
    stringField,
} from './chat-items';
import type {
    AgentChatDriver,
    AgentChatProviderSession,
    AgentChatSessionHost,
    ChatFork,
    ChatForkTarget,
    ChatInputOptions,
    ChatProcessEnd,
    ChatRewindTarget,
    ChatSideExchange,
    ChatTaskHistory,
} from './chat-provider';
import { chatTextDigest } from './chat-turn-answer';
import type { CodexThreadSettings } from './codex-chat-types';
import { CodexComputerUseBindings } from './codex-computer-use';
import { CodexDeliveryCheck, TURN_REQUEST_TIMEOUT_MS } from './codex-delivery-check';
import { CodexGoals } from './codex-goals';
import {
    CODEX_COMMANDS,
    codexClientMessageId,
    CodexThumbnails,
    codexUserInput,
    isSteerTargetGone,
} from './codex-input';
import { didInterruptTimeout } from './codex-interrupt';
import { loadCodexItemTimes } from './codex-item-times';
import { mapCodexErrorNotice, mapCodexItem, mapCodexPlan } from './codex-items';
import { readCodexMcpServer } from './codex-mcp-servers';
import { CodexModelSettings, CodexUsage } from './codex-models';
import { codexOpeningSettings, CodexPermissions } from './codex-permissions';
import { CodexRequestBroker } from './codex-requests';
import { CodexTasks } from './codex-tasks';
import { initializeCodexConnection, openCodexThread } from './codex-thread-open';
import { finishedTurnOperations, historyOperations } from './codex-turns';
import { JsonRpcConnection, JsonRpcRequestError } from './json-rpc-connection';
import { forkCodexThread, revertCodexThread } from './rewind/codex-rewind';
import { CodexSideQuestions } from './side-question/codex-side-question';

type Json = Record<string, unknown>;

/**
 * One live `codex app-server` process bound to one Chat Terminal. It translates the provider protocol into projection
 * operations and lifecycle events; the owning service persists, broadcasts, and serializes them.
 */
class CodexChatSession implements AgentChatProviderSession {
    private readonly settings: CodexThreadSettings;

    private connection: JsonRpcConnection | undefined;

    private threadId: string | undefined;

    private isThreadBound: boolean;

    private requested = false;

    private turnCount = 0;

    /**
     * Digest of the message a `turn/start` in flight carries, reported with the `turnStarted` that request opens. The
     * service's send chain allows one request at a time, so at most one is pending.
     */
    private pendingPromptDigest: string | undefined;

    private readonly thumbnails = new CodexThumbnails();

    private readonly computerUse = new CodexComputerUseBindings();

    private readonly deliveries: CodexDeliveryCheck;

    private readonly requests: CodexRequestBroker;

    private readonly tasks: CodexTasks;

    private readonly models: CodexModelSettings;

    private readonly permissions: CodexPermissions;

    private readonly goals: CodexGoals;

    private readonly usage: CodexUsage;

    private readonly sideQuestions = new CodexSideQuestions();

    constructor(private readonly options: AgentChatSessionHost) {
        const opening = codexOpeningSettings(options);
        this.settings = opening.settings;
        this.threadId = options.agentSessionId;
        this.isThreadBound = Boolean(options.agentSessionId);
        this.tasks = new CodexTasks(options, {
            request: (method, parameters, timeoutMs) =>
                this.requireConnection().request(method, parameters, timeoutMs),
            threadId: () => this.threadId,
        });
        this.permissions = new CodexPermissions(options, this.settings, opening.planMode);
        this.models = new CodexModelSettings(options, this.permissions);
        this.deliveries = new CodexDeliveryCheck(options, () => this.threadId);
        this.requests = new CodexRequestBroker(options, () => this.threadId);
        this.goals = new CodexGoals(options, () => this.threadId);
        this.usage = new CodexUsage(options);
    }

    private requireConnection(): JsonRpcConnection {
        if (!this.connection?.isOpen || !this.threadId)
            throw new CaxriError('UNAVAILABLE', 'Codex Chat is not running');
        return this.connection;
    }

    private loadHistory(thread: Json, model: string | undefined): void {
        this.options.apply(historyOperations(thread, model));
        this.tasks.replay(thread);
        if (this.connection && this.threadId)
            // eslint-disable-next-line no-void -- best effort: an item Codex has no time for stays undated
            void loadCodexItemTimes(this.connection, this.threadId, this.options);
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
        this.options.apply([startedTurnOperation(snapshot, id)]);
        const agentPromptDigest = this.pendingPromptDigest;
        this.pendingPromptDigest = undefined;
        this.options.lifecycle({
            phase: 'turnStarted',
            agentSessionId: this.threadId,
            agentTurnId: id,
            ...(agentPromptDigest && { agentPromptDigest }),
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
            (requestId, finishedTurnId) => this.requests.outlivesTurn(requestId, finishedTurnId),
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
        // eslint-disable-next-line no-void -- best effort: an unreadable list leaves the tasks as they are
        void this.tasks.reconcileTerminals();
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
        // A side question's fork is a thread of its own; keep it away from the subagent routing below.
        if (this.sideQuestions.onNotification(threadId, method, parameters)) return;
        /**
         * Server requests of a subagent are answered through the Chat like its own, so their resolution is too.
         */
        if (method !== 'serverRequest/resolved' && this.tasks.isOtherThread(threadId)) {
            this.tasks.onChildNotification(threadId, method, parameters);
            return;
        }
        if (this.usage.onNotification(method, parameters)) return;
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
            case 'error': {
                this.options.apply([
                    { op: 'upsertItem', item: mapCodexErrorNotice(parameters, turnId) },
                ]);
                return;
            }
            case 'thread/goal/updated':
            case 'thread/goal/cleared': {
                if (!threadId || threadId === this.threadId)
                    this.goals.onNotification(method, parameters);
                return;
            }
            case 'serverRequest/resolved': {
                this.requests.onResolved(parameters.requestId);
                return;
            }
            default: {
                // MCP startup and warning notifications are not conversation content.
            }
        }
    }

    private onItem(raw: unknown, turnId: string | undefined, isStarted: boolean): void {
        const mapped = mapCodexItem(raw, turnId, isStarted, this.computerUse);
        const item = mapped && this.thumbnails.apply(mapped, raw);
        const operations: AgentChatPatchOperation[] = item ? [{ op: 'upsertItem', item }] : [];
        const type = isRecord(raw) ? raw.type : undefined;
        if (type === 'contextCompaction')
            operations.push({
                op: 'state',
                state: { operation: isStarted ? 'compacting' : null },
            });
        if (operations.length > 0) this.options.apply(operations);
        if (!isRecord(raw)) return;
        if (type === 'userMessage') this.deliveries.rememberEcho(raw.clientId);
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

    private onEnd(end: ChatProcessEnd): void {
        const snapshot = this.options.read();
        const { activeTurnId } = snapshot;
        const operations = endedSessionOperations(snapshot);
        const unanswered = this.requests.drain();
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
            rejectedRequests: this.requests.rejected,
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
            processGroups: this.options.processGroups,
            handlers: {
                onNotification: (method, parameters) => this.onNotification(method, parameters),
                onServerRequest: (request) => this.requests.receive(connection, request),
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
            instructions: this.options.instructions,
            ...(this.threadId && { threadId: this.threadId }),
        });
        if (opened.outcome === 'resumed') {
            this.loadHistory(opened.thread, opened.model);
            this.models.reportOpened(opened);
            this.permissions.reportOpened(opened.collaborationMode);
            return 'resumed';
        }
        this.threadId = opened.threadId;
        if (opened.model)
            this.options.apply([{ op: 'state', state: { model: clip(opened.model, 200) } }]);
        this.models.reportOpened(opened);
        this.permissions.reportOpened(opened.collaborationMode);
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
        await this.goals.load(this.requireConnection());
        await this.usage.loadSignIn(this.requireConnection());
        // eslint-disable-next-line no-void -- best effort: an unreadable list leaves the tasks as they are
        void this.tasks.reconcileTerminals();
        return outcome;
    }

    async send(
        message: Omit<AgentChatMessageInput, 'delivery'>,
        options: ChatInputOptions = {},
    ): Promise<void> {
        const connection = this.requireConnection();
        let clientUserMessageId = codexClientMessageId(options.delivery);
        const input = codexUserInput(message);
        this.thumbnails.remember(clientUserMessageId, message);
        const { activeTurnId } = this.options.read();
        if (activeTurnId && options.delivery === 'steered') {
            try {
                await this.deliveries.request(
                    connection,
                    'turn/steer',
                    clientUserMessageId,
                    (timeoutMs) =>
                        connection.request(
                            'turn/steer',
                            {
                                threadId: this.threadId,
                                input,
                                expectedTurnId: activeTurnId,
                                clientUserMessageId,
                            },
                            timeoutMs,
                        ),
                );
                return;
            } catch (error) {
                /**
                 * The turn can finish between reading `activeTurnId` and the steer arriving; Codex then rejects the
                 * precondition and the message starts the next turn instead of being lost. It was not steered after
                 * all, so it goes out under a new id that carries no marker.
                 */
                if (!(error instanceof JsonRpcRequestError)) throw error;
                if (!isSteerTargetGone(error))
                    throw new CaxriError(
                        'CONFLICT',
                        'Codex cannot add this message to the running turn',
                    );
                clientUserMessageId = codexClientMessageId();
                this.thumbnails.remember(clientUserMessageId, message);
            }
        }
        this.pendingPromptDigest = chatTextDigest(message.text);
        let result: unknown;
        try {
            result = await this.deliveries.request(
                connection,
                'turn/start',
                clientUserMessageId,
                (timeoutMs) =>
                    this.models.startTurn(
                        connection,
                        {
                            threadId: this.threadId,
                            input,
                            summary: 'detailed',
                            clientUserMessageId,
                        },
                        timeoutMs,
                    ),
            );
        } catch (error) {
            this.pendingPromptDigest = undefined;
            throw error;
        }
        const turn = isRecord(result) && isRecord(result.turn) ? result.turn : undefined;
        const turnId = stringField(turn?.id);
        // `turn/started` normally arrives first; the response covers a provider that reorders them.
        if (turnId) this.beginTurn(turnId);
        // A digest no turn consumed (no id came back) must not attach to a turn Codex later starts on its own.
        this.pendingPromptDigest = undefined;
    }

    isImmediateCommand(name: string): boolean {
        return name === AGENT_CHAT_GOAL_COMMAND;
    }

    async runCommand(name: string, arguments_?: string): Promise<void> {
        if (name === AGENT_CHAT_GOAL_COMMAND) {
            const change: AgentChatGoalChange | undefined = parseAgentChatGoalArguments(arguments_);
            if (!change) throw new CaxriError('VALIDATION', 'Describe the goal after /goal');
            await this.goals.change(this.requireConnection(), change);
            return;
        }
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

    setPermission(permission: AgentChatPermission): Promise<void> {
        return this.permissions.set(permission, this.requireConnection(), this.options.cwd);
    }

    rewind(target: ChatRewindTarget): Promise<undefined> {
        return revertCodexThread(this.requireConnection(), this.threadId, target);
    }

    async fork(target: ChatForkTarget | undefined): Promise<ChatFork> {
        return {
            agentSessionId: await forkCodexThread(
                this.requireConnection(),
                this.threadId,
                target,
                (reason) => this.options.onForkReleaseFailed(reason),
            ),
        };
    }

    async interrupt(): Promise<void> {
        const connection = this.requireConnection();
        const { activeTurnId } = this.options.read();
        if (!activeTurnId) return;
        await this.goals.pauseForInterrupt(connection);
        if (await didInterruptTimeout(connection, this.threadId, activeTurnId)) await this.close();
    }

    async refreshTasks(): Promise<void> {
        this.requireConnection();
        await this.tasks.reconcileTerminals();
    }

    async stopTask(taskId: string): Promise<void> {
        this.requireConnection();
        await this.tasks.stopTask(taskId);
    }

    async readTaskHistory(taskId: string): Promise<ChatTaskHistory | undefined> {
        if (!this.connection?.isOpen || !this.threadId) return undefined;
        return this.tasks.readTaskHistory(taskId);
    }

    askSideQuestion(question: string, history: readonly ChatSideExchange[]): Promise<string> {
        const { threadId } = this;
        const connection = this.requireConnection();
        return this.sideQuestions.ask(
            connection,
            threadId!,
            this.options.read(),
            question,
            history,
        );
    }

    readMcpServer(name: string) {
        return this.connection?.isOpen && this.threadId
            ? readCodexMcpServer(this.connection, this.threadId, name)
            : Promise.resolve(undefined);
    }

    respond(requestId: string, response: AgentChatResponse): void {
        this.requests.respond(this.requireConnection(), requestId, response);
    }

    async close(): Promise<void> {
        this.requested = true;
        await this.connection?.close();
    }
}

export const codexChatDriver: AgentChatDriver = {
    create: (host) => new CodexChatSession(host),
};
