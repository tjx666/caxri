import { randomUUID } from 'node:crypto';

import type {
    Query,
    SDKMessage,
    SDKResultMessage,
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
import { CaxriError, MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import {
    clip,
    endedSessionOperations,
    isRecord,
    MAX_TRACKED_TURNS,
    stringField,
} from './chat-items';
import type {
    AgentChatDriver,
    AgentChatProviderSession,
    AgentChatResponse,
    AgentChatSessionHost,
    ChatProcessEnd,
} from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import { claudeHistoryOperations } from './claude-history';
import { ClaudeCommandList, claudeCommandPrompt, claudeUserPrompt } from './claude-input';
import {
    claudeAssistantItems,
    ClaudeBlockIds,
    claudeContextWindow,
    claudeUsageTokens,
    finishedClaudeTurn,
    settleClaudeToolItem,
} from './claude-items';
import { claudeChatModels, claudeInitEffort, configureClaudeModel } from './claude-models';
import { PromptQueue, withTimeout } from './claude-prompt-queue';
import { ClaudeRequestBroker } from './claude-requests';
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
 * Claude Code has no turn ids: a turn is identified by the uuid of the user message that started it, and ends with the
 * `result` message once no queued message is left to fold in.
 *
 * @see https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
 */
class ClaudeChatSession implements AgentChatProviderSession {
    private readonly settings: ClaudeChatSettings;

    private readonly prompts = new PromptQueue();

    private readonly requests: ClaudeRequestBroker;

    private readonly ids = new ClaudeBlockIds();

    /**
     * Streamed block index to item id for the model message being streamed, and which of those items exist yet.
     */
    private readonly streamingBlocks = new Map<number, string>();

    private readonly streamedItems = new Set<string>();

    private streamingMessageId: string | undefined;

    private query: Query | undefined;

    private process: ProviderProcess | undefined;

    private spawnErrorCode: string | undefined;

    private sessionId: string;

    private isSessionBound: boolean;

    private isEnded = false;

    private requested = false;

    private isInterruptRequested = false;

    private contextWindow: number | undefined;

    private turnCount = 0;

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
                this.isInterruptRequested = true;
            },
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

    private beginTurn(id: string): void {
        const snapshot = this.options.read();
        if (!this.isSessionBound) {
            this.isSessionBound = true;
            this.options.onSessionBound(this.sessionId);
            this.options.lifecycle({ phase: 'sessionIdentified', agentSessionId: this.sessionId });
        }
        this.turnCount += 1;
        this.isInterruptRequested = false;
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
            agentSessionId: this.sessionId,
            agentTurnId: id,
        });
    }

    private finishTurn(result: SDKResultMessage): void {
        const usageWindow = claudeContextWindow(result.modelUsage);
        if (usageWindow) this.contextWindow = usageWindow;
        // A message sent during the turn is folded into it; the turn ends with the last result.
        if ((result.queued_turn_count ?? 0) > 0) return;
        const snapshot = this.options.read();
        const id = snapshot.activeTurnId;
        if (!id) return;
        const isSuccess = result.subtype === 'success' && !result.is_error;
        const status = this.isInterruptRequested
            ? 'interrupted'
            : isSuccess
              ? 'completed'
              : 'failed';
        const error =
            result.subtype === 'success' ? result.result : result.errors.filter(Boolean).join('\n');
        this.isInterruptRequested = false;
        this.requests.settleAll('Turn ended');
        const finished = finishedClaudeTurn(
            this.options.read(),
            id,
            status,
            error || 'Claude could not finish this turn',
        );
        this.options.apply(finished.operations);
        if (this.contextWindow && snapshot.usage)
            this.options.apply([
                {
                    op: 'state',
                    state: { usage: { ...snapshot.usage, contextWindow: this.contextWindow } },
                },
            ]);
        this.options.onTurnFinished(status, finished.durationMs);
        this.options.lifecycle(
            status === 'failed'
                ? {
                      phase: 'turnFailed',
                      agentSessionId: this.sessionId,
                      agentTurnId: id,
                      agentFailure: 'provider_failed',
                  }
                : { phase: 'turnFinished', agentSessionId: this.sessionId, agentTurnId: id },
        );
    }

    private onStreamEvent(event: unknown): void {
        if (!isRecord(event)) return;
        switch (event.type) {
            case 'message_start': {
                const message = isRecord(event.message) ? event.message : undefined;
                this.streamingMessageId = stringField(message?.id);
                this.streamingBlocks.clear();
                return;
            }
            case 'content_block_start': {
                const block = isRecord(event.content_block) ? event.content_block : undefined;
                const kind =
                    block?.type === 'text'
                        ? 'text'
                        : block?.type === 'thinking'
                          ? 'thinking'
                          : undefined;
                if (!kind || !this.streamingMessageId || typeof event.index !== 'number') return;
                this.streamingBlocks.set(event.index, this.ids.open(this.streamingMessageId, kind));
                return;
            }
            case 'content_block_delta': {
                const delta = isRecord(event.delta) ? event.delta : undefined;
                const itemId =
                    typeof event.index === 'number'
                        ? this.streamingBlocks.get(event.index)
                        : undefined;
                if (!delta || !itemId) return;
                if (delta.type === 'text_delta')
                    this.appendDelta(itemId, 'agentMessage', delta.text);
                else if (delta.type === 'thinking_delta')
                    this.appendDelta(itemId, 'reasoning', delta.thinking);
                return;
            }
            default: {
                // Stop and usage events carry nothing the complete assistant frame does not repeat.
            }
        }
    }

    /**
     * Streams a delta into a text or thinking block. The item is created by its first delta rather than its block
     * start, so a thinking block whose content is withheld never shows as an empty row.
     */
    private appendDelta(itemId: string, type: 'agentMessage' | 'reasoning', delta: unknown): void {
        if (typeof delta !== 'string' || !delta) return;
        const text = clip(delta, MAX_AGENT_CHAT_TEXT_LENGTH);
        if (this.streamedItems.has(itemId)) {
            this.options.apply([{ op: 'appendText', itemId, delta: text }]);
            return;
        }
        this.streamedItems.add(itemId);
        const turnId = this.options.read().activeTurnId;
        this.options.apply([
            {
                op: 'upsertItem',
                item: { id: itemId, ...(turnId && { turnId }), type, text, streaming: true },
            },
        ]);
    }

    private onAssistant(message: unknown): void {
        if (!isRecord(message)) return;
        const turnId = this.options.read().activeTurnId;
        const mapped = claudeAssistantItems(message, turnId, this.ids);
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
                            ...(this.contextWindow && { contextWindow: this.contextWindow }),
                        },
                    },
                },
            ]);
        for (const item of mapped.items) this.streamedItems.delete(item.id);
    }

    private onToolResults(message: SDKUserMessage): void {
        const content = isRecord(message.message) ? message.message.content : undefined;
        if (!Array.isArray(content)) return;
        const items = new Map(this.options.read().items.map((item) => [item.id, item]));
        for (const block of content) {
            if (!isRecord(block) || block.type !== 'tool_result') continue;
            const toolUseId = stringField(block.tool_use_id);
            if (!toolUseId) continue;
            const id = clip(toolUseId, 200);
            const wasDeclined = this.requests.takeDeclined(id);
            const item = items.get(id);
            const settled =
                item && settleClaudeToolItem(item, block, message.tool_use_result, wasDeclined);
            if (settled) this.options.apply([{ op: 'upsertItem', item: settled }]);
        }
    }

    private onSystem(message: Json): void {
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
            case 'compact_boundary': {
                const turnId = this.options.read().activeTurnId;
                const id = clip(`compact:${stringField(message.uuid) ?? randomUUID()}`, 200);
                this.options.apply([
                    {
                        op: 'upsertItem',
                        item: { id, ...(turnId && { turnId }), type: 'notice', kind: 'compacted' },
                    },
                ]);
                this.options.lifecycle({ phase: 'compactionFinished' });
                return;
            }
            case 'api_retry': {
                const turnId = this.options.read().activeTurnId;
                if (!turnId) return;
                const attempt = typeof message.attempt === 'number' ? message.attempt : undefined;
                this.options.apply([
                    {
                        op: 'upsertItem',
                        item: {
                            id: clip(`${turnId}:retry`, 200),
                            turnId,
                            type: 'notice',
                            kind: 'retrying',
                            ...(attempt !== undefined && { message: `Attempt ${attempt}` }),
                        },
                    },
                ]);
                return;
            }
            default: {
                // Hook, status, and task notifications are not conversation content.
            }
        }
    }

    private onMessage(message: SDKMessage): void {
        if (this.isEnded) return;
        // Subagent output stays inside its parent tool call, like the TUI.
        if ('parent_tool_use_id' in message && message.parent_tool_use_id) return;
        switch (message.type) {
            case 'stream_event': {
                this.onStreamEvent(message.event);
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
                this.finishTurn(message);
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
            turns: this.turnCount,
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

    private submit(text: string, images: readonly AgentChatImageInput[]): void {
        this.requireOpen();
        const uuid = randomUUID();
        const activeTurnId = this.options.read().activeTurnId;
        const turnId = activeTurnId ?? uuid;
        if (!activeTurnId) this.beginTurn(turnId);
        const prompt = claudeUserPrompt({ uuid, turnId, sessionId: this.sessionId, text, images });
        this.options.apply([{ op: 'upsertItem', item: prompt.item }]);
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
                },
                ...(resumeId ? { resume: resumeId } : { sessionId: this.sessionId }),
                includePartialMessages: true,
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

    send({ text, images = [] }: AgentChatMessageInput): Promise<void> {
        this.submit(text, images);
        return Promise.resolve();
    }

    runCommand(name: string, arguments_: string | undefined): Promise<void> {
        this.submit(claudeCommandPrompt(name, arguments_), []);
        return Promise.resolve();
    }

    async configure(change: AgentChatModelChange): Promise<void> {
        this.options.apply(await configureClaudeModel(this.requireOpen(), change));
    }

    async interrupt(): Promise<void> {
        if (!this.options.read().activeTurnId) return;
        const stream = this.requireOpen();
        this.isInterruptRequested = true;
        try {
            await withTimeout(stream.interrupt(), INTERRUPT_TIMEOUT_MS);
        } catch (error) {
            if (error instanceof CaxriError && error.code === 'TIMEOUT') await this.close();
            // Otherwise the turn already ended; its `result` settles the projection.
        }
    }

    respond(requestId: string, response: AgentChatResponse): void {
        this.requireOpen();
        this.requests.respond(requestId, response);
    }

    async close(): Promise<void> {
        this.requested = true;
        this.prompts.end();
        await this.process?.terminate();
        this.query?.close();
    }
}

export const claudeChatDriver: AgentChatDriver = {
    create: (host) => new ClaudeChatSession(host),
};
