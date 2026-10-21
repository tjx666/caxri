import { randomUUID } from 'node:crypto';

import type {
    Query,
    SDKMessage,
    SDKUserMessage,
    SpawnedProcess,
    SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type {
    AgentChatImageInput,
    AgentChatMessageInput,
    AgentChatModelChange,
    AgentChatPatchOperation,
    AgentChatPermission,
    AgentChatResponse,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { ChatTurnUsage, claudeTurnResponse } from '../usage';
import { clip, isRecord, slashCommandPrompt, stringField } from './chat-items';
import type {
    AgentChatDriver,
    AgentChatProviderSession,
    AgentChatSessionHost,
    ChatFork,
    ChatForkTarget,
    ChatInputOptions,
    ChatRestorePreview,
    ChatResumePoint,
    ChatRewindTarget,
    ChatSideExchange,
    ChatTaskHistory,
} from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import { claudeResponseUsage } from './claude-context';
import { ClaudeContextTracker } from './claude-context-report';
import { claudeHistoryOperations, claudeTaskHistoryOperations } from './claude-history';
import {
    ClaudeCommandList,
    claudePromptUuid,
    claudeUserPrompt,
    isClaudeCompactCommand,
} from './claude-input';
import { claudeAssistantItems } from './claude-items';
import { readClaudeMcpServer } from './claude-mcp-servers';
import {
    claudeChatModels,
    claudeEffortHooks,
    claudeFastMode,
    claudeInitState,
    configureClaudeModel,
    readClaudeAppliedSettings,
} from './claude-models';
import { ClaudePermissions } from './claude-permissions';
import { ClaudePlanLimits } from './claude-plan-limits';
import { PromptQueue, withTimeout } from './claude-prompt-queue';
import { ClaudeRequestBroker } from './claude-requests';
import { reportClaudeSessionEnd } from './claude-session-end';
import { claudeQueryOptions, claudeStartError } from './claude-session-open';
import { withClaudeShellHooks } from './claude-shell-hooks';
import { ClaudeStream } from './claude-stream';
import { readClaudeSubagentTranscript } from './claude-subagent-transcript';
import {
    didApplyClaudeFeedback,
    onClaudeApiRetry,
    onClaudeCompactBoundary,
    onClaudeStatus,
} from './claude-system-notices';
import { ClaudeTasks } from './claude-tasks';
import { ClaudeToolClock, settleClaudeToolResults } from './claude-tool-results';
import { ClaudeTurns } from './claude-turns';
import type { ClaudeChatSettings } from './launch-settings';
import { claudeChatSettings } from './launch-settings';
import { ProviderProcess } from './provider-process';
import {
    forkClaudeSession,
    previewClaudeRestore,
    restoreClaudeFiles,
    rewindClaudeSession,
} from './rewind/claude-rewind';
import { askClaudeSideQuestion } from './side-question/claude-side-question';

/**
 * Claude Code loads settings, plugins, and MCP servers before it answers `initialize`, so its handshake gets more time
 * than Codex's.
 */
const INITIALIZE_TIMEOUT_MS = 30_000;

/**
 * An interrupt that Claude Code never acknowledges stops the process instead, so the Chat cannot stay stuck in a
 * running turn.
 */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * The frame types that carry a subagent's own conversation. The CLI also stamps `parent_tool_use_id` on a running Bash
 * call's own `tool_progress` heartbeats; listing a task from those turned a background shell into a phantom `Agent`.
 */
const CHILD_CONVERSATION_TYPES = new Set<string>(['stream_event', 'assistant', 'user']);

type Json = Record<string, unknown>;

/**
 * One live Claude Code process bound to one Chat Terminal, driven through the Claude Agent SDK's streaming input mode.
 * The SDK speaks Claude Code's stream-json control protocol; Caxri still spawns the user's own `claude` executable
 * through {@link ProviderProcess}, so the process group, exit status, and stop escalation match every other provider.
 *
 * Turn boundaries live in {@link ClaudeTurns}; subagents and background shells in {@link ClaudeTasks}.
 *
 * @see https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
 */
class ClaudeChatSession implements AgentChatProviderSession {
    private readonly settings: ClaudeChatSettings;

    private readonly permissions: ClaudePermissions;

    private readonly prompts = new PromptQueue();

    private readonly requests: ClaudeRequestBroker;

    private readonly stream: ClaudeStream;

    private readonly tasks: ClaudeTasks;
    private readonly toolClock = new ClaudeToolClock();
    private readonly turnUsage = new ChatTurnUsage();
    private readonly planLimits = new ClaudePlanLimits();

    private query: Query | undefined;

    private process: ProviderProcess | undefined;

    private spawnErrorCode: string | undefined;

    private sessionId: string;

    private isSessionBound: boolean;

    private isEnded = false;

    private requested = false;

    private readonly turns: ClaudeTurns;

    private readonly commands = new ClaudeCommandList((commands) =>
        this.options.apply([{ op: 'state', state: { commands } }]),
    );

    private readonly context = new ClaudeContextTracker(() =>
        this.query && this.isOpen
            ? { query: this.query, host: this.options, isEnded: () => this.isEnded }
            : undefined,
    );

    constructor(private readonly options: AgentChatSessionHost) {
        const launched = claudeChatSettings(options.launch);
        this.permissions = new ClaudePermissions(options, launched.permissionMode);
        this.settings = { ...launched, permissionMode: this.permissions.startMode };
        this.sessionId = options.agentSessionId ?? options.newAgentSessionId ?? randomUUID();
        this.isSessionBound = Boolean(options.agentSessionId);
        this.requests = new ClaudeRequestBroker({
            host: options,
            sessionId: () => this.sessionId,
            isEnded: () => this.isEnded,
            onInterruptRequested: () => {
                this.turns.isInterruptRequested = true;
            },
            planExitMode: () => this.permissions.planExitMode(),
        });
        this.turns = new ClaudeTurns({
            host: options,
            bindSession: () => this.bindSession(),
            sessionId: () => this.sessionId,
            settleRequests: () => {
                this.requests.settleAll('Turn ended');
                this.toolClock.clear();
            },
        });
        this.stream = new ClaudeStream(
            (operations) => options.apply(operations),
            () => options.read().activeTurnId,
        );
        this.tasks = new ClaudeTasks({
            host: options,
            query: () => (this.isOpen ? this.query : undefined),
            takeDeclined: (toolUseId) => this.requests.takeDeclined(toolUseId),
            isInterruptRequested: () => this.turns.isInterruptRequested,
            onTasksChanged: () => this.turns.onTasksChanged(),
        });
    }

    private requireOpen(): Query {
        if (!this.query || !this.isOpen)
            throw new CaxriError('UNAVAILABLE', 'Claude Chat is not running');
        return this.query;
    }

    private spawn(spawnOptions: SpawnOptions): SpawnedProcess {
        const providerProcess = new ProviderProcess({
            executable: spawnOptions.command,
            args: spawnOptions.args,
            cwd: spawnOptions.cwd ?? this.options.cwd,
            environment: spawnOptions.env,
            spawnProcess: this.options.spawnProcess,
            processGroups: this.options.processGroups,
        });
        providerProcess.child.once('error', (error: NodeJS.ErrnoException) => {
            this.spawnErrorCode = error.code ?? 'unknown';
        });
        this.process = providerProcess;
        return providerProcess.child;
    }

    /**
     * Binds the Agent Session when its first turn starts; Claude Code has durably recorded it by then.
     */
    private bindSession(): string {
        if (!this.isSessionBound) {
            this.isSessionBound = true;
            this.options.onSessionBound(this.sessionId);
            this.options.lifecycle({ phase: 'sessionIdentified', agentSessionId: this.sessionId });
        }
        return this.sessionId;
    }

    private onAssistant(message: unknown): void {
        if (!isRecord(message)) return;
        this.turns.ensure();
        this.tasks.onAssistant(message);
        const turnId = this.options.read().activeTurnId;
        const mapped = claudeAssistantItems(message, turnId, this.stream.ids);
        const operations: AgentChatPatchOperation[] = mapped.items.map((item) => ({
            op: 'upsertItem',
            item,
        }));
        if (mapped.plan) operations.push({ op: 'state', state: { plan: mapped.plan } });
        if (operations.length > 0) this.options.apply(operations);
        this.turnUsage.record(this.options, claudeTurnResponse(message));
        const usage = claudeResponseUsage(message, this.options.read(), this.turns.contextWindow);
        if (usage) {
            this.options.apply([{ op: 'state', state: { usage } }]);
            this.context.request();
        }
        this.stream.settle(mapped.items);
        this.toolClock.start(mapped.items);
    }

    private onToolResults(message: SDKUserMessage): void {
        const content = isRecord(message.message) ? message.message.content : undefined;
        if (!Array.isArray(content)) return;
        const operations = settleClaudeToolResults(
            content,
            this.options.read().items,
            message.tool_use_result,
            (id) => ({
                wasDeclined: this.requests.takeDeclined(id),
                durationMs: this.toolClock.stop(id),
            }),
        );
        if (operations.length > 0) this.options.apply(operations);
        this.tasks.onToolResults(content);
    }

    private onSystem(message: Json): void {
        if (this.tasks.onSystem(message)) return;
        if (this.tasks.onFeedback(message)) return;
        switch (message.subtype) {
            case 'init': {
                const sessionId = stringField(message.session_id);
                if (sessionId && sessionId !== this.sessionId) {
                    this.sessionId = sessionId;
                    if (this.isSessionBound) this.options.onSessionBound(sessionId);
                }
                this.options.apply(claudeInitState(message));
                this.permissions.onReported(message.permissionMode, this.query);
                this.commands.hideTerminalBound(message.terminal_slash_commands);
                return;
            }
            case 'commands_changed': {
                this.commands.report(message.commands);
                return;
            }
            case 'session_state_changed': {
                this.turns.onSessionState(message.state);
                return;
            }
            case 'status': {
                this.permissions.onReported(message.permissionMode, this.query);
                onClaudeStatus(this.options, message);
                return;
            }
            case 'compact_boundary': {
                onClaudeCompactBoundary(this.options, message);
                // The breakdown described the context before the summary; ask for the rows of the new one.
                this.context.request();
                return;
            }
            case 'api_retry': {
                onClaudeApiRetry(this.options, message);
                return;
            }
            default: {
                didApplyClaudeFeedback(this.options, message, this.tasks.feedbackScope(message));
            }
        }
    }

    private onMessage(message: SDKMessage): void {
        if (this.isEnded) return;
        // A subagent's own conversation goes to its task tab, not the parent timeline.
        if ('parent_tool_use_id' in message && message.parent_tool_use_id) {
            if (CHILD_CONVERSATION_TYPES.has(message.type)) this.tasks.onChildMessage(message);
            // A subagent's responses are part of what the turn that started it spends.
            if (message.type === 'assistant')
                this.turnUsage.record(this.options, claudeTurnResponse(message.message));
            return;
        }
        switch (message.type) {
            case 'stream_event': {
                if (isRecord(message.event) && message.event.type === 'message_start')
                    this.turns.ensure();
                this.stream.onEvent(message.event);
                return;
            }
            case 'assistant': {
                if (didApplyClaudeFeedback(this.options, message)) return;
                this.onAssistant(message.message);
                return;
            }
            case 'user': {
                this.onToolResults(message);
                return;
            }
            case 'result': {
                this.turns.finish(message);
                this.options.apply(claudeFastMode(message));
                if (!this.options.read().activeTurnId) this.context.request();
                return;
            }
            case 'system': {
                this.onSystem(message);
                return;
            }
            default: {
                // Progress and auth events are not conversation content; a rate-limit event updates the plan limits.
                if (message.type === 'rate_limit_event')
                    this.planLimits.observe(message.rate_limit_info);
            }
        }
    }

    private onEnd(): void {
        if (this.isEnded) return;
        this.isEnded = true;
        this.prompts.end();
        this.tasks.close();
        reportClaudeSessionEnd({
            child: this.process?.child,
            host: this.options,
            requested: this.requested,
            requests: this.requests,
            sessionId: this.sessionId,
            spawnErrorCode: this.spawnErrorCode,
            turns: this.turns.count,
        });
    }

    private async consume(stream: Query): Promise<void> {
        try {
            for await (const message of stream) this.onMessage(message);
        } catch {
            // The SDK rejects the stream when the process exits abnormally; the exit status below records why.
        }
        await this.process?.exited;
        this.onEnd();
    }

    private reportAppliedSettings(stream: Query): void {
        // eslint-disable-next-line no-void -- best effort; each turn's hooks still report the effort it ran with
        void readClaudeAppliedSettings(stream)
            .then((operations) => !this.isEnded && this.options.apply(operations))
            .catch(() => {});
    }

    /**
     * Sends a prompt: it starts a turn, or joins the running one when the service steers it there. A steered prompt
     * goes out with `priority: 'next'` so Claude Code folds it in at its next model request.
     */
    private submit(
        text: string,
        images: readonly AgentChatImageInput[],
        options: ChatInputOptions & { isHidden?: boolean } = {},
    ): void {
        this.requireOpen();
        const uuid = claudePromptUuid(options.delivery);
        const activeTurnId = this.options.read().activeTurnId;
        const turnId = activeTurnId ?? uuid;
        if (!activeTurnId) this.turns.begin(turnId, { isOwnPrompt: true, prompt: text });
        const prompt = claudeUserPrompt({
            uuid,
            turnId,
            sessionId: this.sessionId,
            text,
            images,
            ...(options.delivery && { delivery: options.delivery }),
            ...(activeTurnId && options.delivery === 'steered' && { priority: 'next' as const }),
        });
        if (!options.isHidden) this.options.apply([{ op: 'upsertItem', item: prompt.item }]);
        this.prompts.push(prompt.message);
    }

    get isOpen(): boolean {
        return this.process !== undefined && !this.isEnded;
    }

    /**
     * Spawns Claude Code and completes the SDK handshake. A bound Agent Session resumes with `--resume`, and its
     * history comes from the transcript, because Claude Code does not replay a resumed conversation over the protocol.
     */
    async start(): Promise<'resumed' | 'started'> {
        const resumeId = this.isSessionBound ? this.sessionId : undefined;
        const { resumeAt } = this.options;
        const transcript = resumeId ? await this.options.readTranscript() : undefined;
        if (resumeId && !transcript)
            throw new AgentChatStartError(
                'resume_failed',
                'Claude could not find this conversation',
            );
        /**
         * The SDK bundle is over a megabyte; load it with the first Claude Chat, not with Server Core.
         */
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const hooks = withClaudeShellHooks(
            claudeEffortHooks((operations) => this.options.apply(operations)),
            (event) => this.options.observeLifecycle(event),
        );
        const stream = query({
            prompt: this.prompts,
            options: claudeQueryOptions({
                host: this.options,
                settings: this.settings,
                resumeId,
                resumeAt,
                sessionId: this.sessionId,
                spawn: (spawnOptions) => this.spawn(spawnOptions),
                canUseTool: async (...arguments_) => this.requests.canUseTool(...arguments_),
                hooks,
            }),
        });
        this.query = stream;
        // eslint-disable-next-line no-void -- the read loop runs for the process lifetime and reports through onEnd.
        void this.consume(stream);
        try {
            const initialized = await withTimeout(
                stream.initializationResult(),
                INITIALIZE_TIMEOUT_MS,
            );
            this.commands.report(initialized.commands);
            const models = claudeChatModels(initialized.models);
            if (models.length > 0) this.options.apply([{ op: 'state', state: { models } }]);
            this.options.apply(claudeFastMode(initialized));
            this.reportAppliedSettings(stream);
            this.permissions.report();
        } catch {
            const spawnErrorCode = this.spawnErrorCode;
            await this.close();
            throw claudeStartError(spawnErrorCode, resumeId !== undefined);
        }
        if (transcript)
            this.options.apply(
                claudeHistoryOperations(transcript.content, transcript.truncated, resumeAt),
            );
        return resumeId ? 'resumed' : 'started';
    }

    send(
        { text, images = [] }: Omit<AgentChatMessageInput, 'delivery'>,
        options?: ChatInputOptions,
    ): Promise<void> {
        this.submit(text, images, options);
        return Promise.resolve();
    }

    runCommand(
        name: string,
        arguments_: string | undefined,
        options?: ChatInputOptions,
    ): Promise<void> {
        const prompt = slashCommandPrompt(name, arguments_);
        this.submit(prompt, [], { ...options, isHidden: isClaudeCompactCommand(prompt) });
        return Promise.resolve();
    }

    async configure(change: AgentChatModelChange): Promise<void> {
        const stream = this.requireOpen();
        await configureClaudeModel(
            stream,
            change,
            { ultracode: this.options.read().ultracode },
            (operations) => this.options.apply(operations),
        );
        // A model switch can move the effort too, to the new model's default or to none, and can withdraw ultracode.
        this.reportAppliedSettings(stream);
    }

    setPermission(permission: AgentChatPermission): Promise<void> {
        return this.permissions.set(this.requireOpen(), permission);
    }

    async rewind(target: ChatRewindTarget): Promise<ChatResumePoint> {
        const query = this.requireOpen();
        return rewindClaudeSession(query, await this.options.readTranscript(), target);
    }

    async fork(target: ChatForkTarget | undefined): Promise<ChatFork> {
        this.requireOpen();
        const transcript = await this.options.readTranscript();
        return forkClaudeSession(this.sessionId, this.options, transcript, target);
    }

    async restoreFiles(target: ChatRewindTarget): Promise<void> {
        await restoreClaudeFiles(this.requireOpen(), target.itemId);
    }

    previewRestoreFiles(target: ChatRewindTarget): Promise<ChatRestorePreview> {
        return previewClaudeRestore(this.requireOpen(), target.itemId);
    }

    async interrupt(): Promise<void> {
        if (!this.options.read().activeTurnId) return;
        const stream = this.requireOpen();
        this.turns.isInterruptRequested = true;
        try {
            await withTimeout(stream.interrupt(), INTERRUPT_TIMEOUT_MS);
        } catch (error) {
            if (error instanceof CaxriError && error.code === 'TIMEOUT') await this.close();
            // Otherwise the turn already ended; its `result` settles the projection.
        }
    }

    async stopTask(taskId: string): Promise<void> {
        this.requireOpen();
        await this.tasks.stop(taskId);
    }

    /**
     * Rebuilds a subagent this process never streamed (an earlier process, a resumed conversation) from the transcript
     * Claude Code wrote for it. A background shell keeps no record once its process is gone.
     */
    async readTaskHistory(taskId: string): Promise<ChatTaskHistory | undefined> {
        const transcript = await readClaudeSubagentTranscript({
            environment: this.options.environment,
            cwd: this.options.cwd,
            sessionId: this.sessionId,
            toolUseId: taskId,
        });
        if (!transcript) return undefined;
        return {
            taskId: clip(transcript.toolUseId, 200),
            operations: claudeTaskHistoryOperations(transcript.content, transcript.truncated),
        };
    }

    readContext() {
        return this.context.read(this.requireOpen());
    }

    askSideQuestion(question: string, history: readonly ChatSideExchange[]) {
        return askClaudeSideQuestion(this.requireOpen(), question, history);
    }

    readPlanLimits() {
        return this.planLimits.read(this.isOpen ? this.query : undefined);
    }

    readMcpServer(name: string) {
        return this.query && this.isOpen
            ? readClaudeMcpServer(this.query, name)
            : Promise.resolve(undefined);
    }

    respond(requestId: string, response: AgentChatResponse): void {
        this.requireOpen();
        this.requests.respond(requestId, response);
    }

    async close(): Promise<void> {
        this.requested = true;
        this.tasks.close();
        this.prompts.end();
        await this.process?.terminate();
        this.query?.close();
    }
}

export const claudeChatDriver: AgentChatDriver = {
    create: (host) => new ClaudeChatSession(host),
};
