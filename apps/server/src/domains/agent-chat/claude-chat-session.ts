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
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import {
    clip,
    endedSessionOperations,
    isRecord,
    slashCommandPrompt,
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
import { AgentChatStartError } from './chat-provider';
import { claudeHistoryOperations, claudeTaskHistoryOperations } from './claude-history';
import { ClaudeCommandList, claudeUserPrompt, isClaudeCompactCommand } from './claude-input';
import { claudeAssistantItems, claudeUsageTokens } from './claude-items';
import { claudeChatModels, claudeInitEffort, configureClaudeModel } from './claude-models';
import { PromptQueue, withTimeout } from './claude-prompt-queue';
import { ClaudeRequestBroker } from './claude-requests';
import { ClaudeStream } from './claude-stream';
import { readClaudeSubagentTranscript } from './claude-subagent-transcript';
import { onClaudeApiRetry, onClaudeCompactBoundary, onClaudeStatus } from './claude-system-notices';
import { ClaudeTasks } from './claude-tasks';
import { ClaudeToolClock, settleClaudeToolResults } from './claude-tool-results';
import { ClaudeTurns } from './claude-turns';
import type { ClaudeChatSettings } from './launch-settings';
import { claudeChatSettings } from './launch-settings';
import { ProviderProcess } from './provider-process';

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

    private readonly prompts = new PromptQueue();

    private readonly requests: ClaudeRequestBroker;

    private readonly stream: ClaudeStream;

    private readonly tasks: ClaudeTasks;
    private readonly toolClock = new ClaudeToolClock();

    private query: Query | undefined;

    private process: ProviderProcess | undefined;

    private spawnErrorCode: string | undefined;

    private sessionId: string;

    private isSessionBound: boolean;

    private isEnded = false;

    private requested = false;

    private readonly turns: ClaudeTurns;

    private readonly commands = new ClaudeCommandList();

    constructor(private readonly options: AgentChatSessionHost) {
        this.settings = claudeChatSettings(options.launch);
        this.sessionId = options.agentSessionId ?? randomUUID();
        this.isSessionBound = Boolean(options.agentSessionId);
        this.requests = new ClaudeRequestBroker({
            host: options,
            sessionId: () => this.sessionId,
            isEnded: () => this.isEnded,
            onInterruptRequested: () => {
                this.turns.isInterruptRequested = true;
            },
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
        const totalTokens = claudeUsageTokens(message.usage);
        if (operations.length > 0) this.options.apply(operations);
        if (totalTokens !== undefined)
            this.options.apply([
                {
                    op: 'state',
                    state: {
                        usage: {
                            totalTokens,
                            ...(this.turns.contextWindow && {
                                contextWindow: this.turns.contextWindow,
                            }),
                        },
                    },
                },
            ]);
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
        switch (message.subtype) {
            case 'init': {
                const sessionId = stringField(message.session_id);
                if (sessionId && sessionId !== this.sessionId) {
                    this.sessionId = sessionId;
                    if (this.isSessionBound) this.options.onSessionBound(sessionId);
                }
                const model = stringField(message.model);
                if (model)
                    this.options.apply([{ op: 'state', state: { model: clip(model, 200) } }]);
                this.options.apply(claudeInitEffort(message));
                const commands = this.commands.hideTerminalBound(message.terminal_slash_commands);
                if (commands) this.options.apply([{ op: 'state', state: { commands } }]);
                return;
            }
            case 'commands_changed': {
                this.reportCommands(message.commands);
                return;
            }
            case 'session_state_changed': {
                this.turns.onSessionState(message.state);
                return;
            }
            case 'status': {
                onClaudeStatus(this.options, message);
                return;
            }
            case 'compact_boundary': {
                onClaudeCompactBoundary(this.options, message);
                return;
            }
            case 'api_retry': {
                onClaudeApiRetry(this.options, message);
                return;
            }
            default: {
                // Hook and other notifications are not conversation content.
            }
        }
    }

    private onMessage(message: SDKMessage): void {
        if (this.isEnded) return;
        // A subagent's own conversation goes to its task tab, not the parent timeline.
        if ('parent_tool_use_id' in message && message.parent_tool_use_id) {
            this.tasks.onChildMessage(message);
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
                this.onAssistant(message.message);
                return;
            }
            case 'user': {
                this.onToolResults(message);
                return;
            }
            case 'result': {
                this.turns.finish(message);
                return;
            }
            case 'system': {
                this.onSystem(message);
                return;
            }
            default: {
                // Progress, rate-limit, and auth events are not conversation content.
            }
        }
    }

    private onEnd(): void {
        if (this.isEnded) return;
        this.isEnded = true;
        this.prompts.end();
        this.tasks.close();
        const snapshot = this.options.read();
        const { activeTurnId } = snapshot;
        const keys = this.requests.drain();
        this.options.apply(endedSessionOperations(snapshot));
        for (const key of keys)
            this.options.lifecycle({
                phase: 'attentionResolved',
                agentSessionId: this.sessionId,
                agentToolUseId: key,
            });
        const child = this.process?.child;
        const end: ChatProcessEnd = this.requested
            ? { reason: 'closed' }
            : this.spawnErrorCode !== undefined || !child?.pid
              ? { reason: 'spawnFailed', ...(this.spawnErrorCode && { code: this.spawnErrorCode }) }
              : { reason: 'exited', exitCode: child.exitCode, signal: child.signalCode };
        this.options.onExit({
            end,
            requested: this.requested,
            ...(activeTurnId && { activeTurnId }),
            turns: this.turns.count,
            serverRequests: this.requests.count,
            rejectedRequests: 0,
            droppedFrames: 0,
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

    private reportCommands(commands: unknown): void {
        this.options.apply([{ op: 'state', state: { commands: this.commands.report(commands) } }]);
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
        const uuid = randomUUID();
        const activeTurnId = this.options.read().activeTurnId;
        const turnId = activeTurnId ?? uuid;
        if (!activeTurnId) this.turns.begin(turnId, { isOwnPrompt: true });
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
        const transcript = resumeId ? await this.options.readTranscript() : undefined;
        if (resumeId && !transcript)
            throw new AgentChatStartError(
                'resume_failed',
                'Claude could not find this conversation',
            );
        const { settings } = this;
        /**
         * The SDK bundle is over a megabyte; load it with the first Claude Chat, not with Server Core.
         */
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const stream = query({
            prompt: this.prompts,
            options: {
                cwd: this.options.cwd,
                pathToClaudeCodeExecutable: this.options.executable,
                spawnClaudeCodeProcess: (spawnOptions) => this.spawn(spawnOptions),
                env: {
                    ...this.options.environment,
                    CLAUDE_AGENT_SDK_CLIENT_APP: `caxri/${this.options.clientVersion}`,
                    // Reports `system/session_state_changed`, the authoritative turn boundary.
                    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
                },
                ...(resumeId ? { resume: resumeId } : { sessionId: this.sessionId }),
                includePartialMessages: true,
                // Subagent text and thinking reach the task tab, not only their tool calls.
                forwardSubagentText: true,
                // The Chat stops tasks one at a time, so an interrupt ends only the turn and spares background work.
                perTaskStopAffordance: true,
                systemPrompt: { type: 'preset', preset: 'claude_code' },
                tools: { type: 'preset', preset: 'claude_code' },
                permissionMode: settings.permissionMode,
                ...(settings.permissionMode === 'bypassPermissions' && {
                    allowDangerouslySkipPermissions: true,
                }),
                ...(settings.model && { model: settings.model }),
                ...(settings.settings && { settings: settings.settings }),
                ...(settings.additionalDirectories.length > 0 && {
                    additionalDirectories: settings.additionalDirectories,
                }),
                ...(settings.allowedTools.length > 0 && { allowedTools: settings.allowedTools }),
                ...(settings.disallowedTools.length > 0 && {
                    disallowedTools: settings.disallowedTools,
                }),
                canUseTool: async (...arguments_) => this.requests.canUseTool(...arguments_),
            },
        });
        this.query = stream;
        // eslint-disable-next-line no-void -- the read loop runs for the process lifetime and reports through onEnd.
        void this.consume(stream);
        try {
            const initialized = await withTimeout(
                stream.initializationResult(),
                INITIALIZE_TIMEOUT_MS,
            );
            this.reportCommands(initialized.commands);
            const models = claudeChatModels(initialized.models);
            if (models.length > 0) this.options.apply([{ op: 'state', state: { models } }]);
        } catch {
            const spawnErrorCode = this.spawnErrorCode;
            await this.close();
            if (spawnErrorCode !== undefined)
                throw spawnErrorCode === 'ENOENT'
                    ? new AgentChatStartError('executable_not_found', 'Claude CLI was not found')
                    : new AgentChatStartError('spawn_failed', 'Claude could not be started');
            if (resumeId)
                throw new AgentChatStartError(
                    'resume_failed',
                    'Claude could not resume this conversation',
                );
            throw new AgentChatStartError(
                'handshake_failed',
                'Claude did not complete its handshake',
            );
        }
        if (transcript)
            this.options.apply(claudeHistoryOperations(transcript.content, transcript.truncated));
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
        await configureClaudeModel(this.requireOpen(), change, (operations) =>
            this.options.apply(operations),
        );
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
