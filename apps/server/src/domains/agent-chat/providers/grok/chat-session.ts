import { randomUUID } from 'node:crypto';

import type {
    AgentChatMessageInput,
    AgentChatModelChange,
    AgentChatPermissionMode,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { CaxriError, MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import { clip, isRecord, stringField } from '../../chat-items';
import type {
    AgentChatDriver,
    AgentChatSessionHost,
    ChatFork,
    ChatForkTarget,
    ChatRewindTarget,
} from '../../chat-provider';
import type { JsonRpcConnection, JsonRpcServerRequest } from '../../json-rpc-connection';
import { JsonRpcRequestError } from '../../json-rpc-connection';
import { forkGrokSession, rewindGrokSession } from '../../rewind/grok-rewind';
import { acpCommands } from '../acp/items';
import type { AcpActiveTurn } from '../acp/session';
import { AcpChatSession, TURN_REQUEST_TIMEOUT_MS } from '../acp/session';
import {
    grokContextWindow,
    grokDisplayText,
    grokEffort,
    grokModels,
    grokModelState,
    grokQuestionAnswers,
    grokSessionParameters,
    grokToolPresentation,
    grokUsage,
    mapGrokQuestion,
} from './items';
import { grokOpeningSettings } from './permissions';
import { applyGrokExtensionUpdate } from './updates';

type Json = Record<string, unknown>;

/**
 * One live `grok agent stdio` process: ACP with Grok Build's `_x.ai/*` extensions for steering, questions, rewind, and
 * turn completion. See `docs/grok-build.md`.
 */
class GrokChatSession extends AcpChatSession {
    /**
     * The `models` record Grok Build returned when the conversation opened, for the context window of a switched model.
     */
    private listedModels: unknown;

    constructor(options: AgentChatSessionHost) {
        super(
            options,
            {
                provider: 'grok',
                label: 'Grok Build',
                presentation: grokToolPresentation,
                questions: { request: mapGrokQuestion, answers: grokQuestionAnswers },
                displayText: grokDisplayText,
                configState: (configOptions) => {
                    const effort = grokEffort(configOptions);
                    return effort ? { effort } : undefined;
                },
                // A replayed turn without its `turn_completed` was cut off, e.g. by a crash.
                settledReplayTurns: 'interrupted',
            },
            /**
             * Grok Build accepts a client-chosen id through `session/new`'s `_meta.sessionId`, so the id is known
             * before the first turn, as with Claude Code's preset `--session-id`.
             */
            options.agentSessionId ?? randomUUID(),
        );
    }

    protected launchArguments(): {
        args: string[];
        permissionMode: AgentChatPermissionMode | undefined;
    } {
        const { settings, permissionMode } = grokOpeningSettings(this.options);
        return {
            /**
             * `--no-leader` keeps the agent in this process: Grok Build's `[cli] use_leader` setting would otherwise
             * turn stdio into a bridge to a shared leader whose working directory and lifetime Caxri does not own.
             */
            args: [...settings.rootArgs, 'agent', ...settings.agentArgs, '--no-leader', 'stdio'],
            permissionMode,
        };
    }

    protected sessionParameters(): Json {
        return grokSessionParameters(this.options.cwd);
    }

    protected newSessionParameters(): Json {
        const parameters = grokSessionParameters(this.options.cwd);
        return { ...parameters, _meta: { ...parameters._meta, sessionId: this.sessionId } };
    }

    protected promptMeta(turnId: string): Json {
        return { promptId: turnId };
    }

    protected onInitialized(initialized: Json): void {
        const meta = isRecord(initialized._meta) ? initialized._meta : {};
        this.options.apply([
            { op: 'state', state: { commands: acpCommands(meta.availableCommands) } },
        ]);
    }

    protected openingState(opened: unknown): Partial<AgentChatSnapshot> {
        const models = isRecord(opened) ? opened.models : undefined;
        const { model, contextWindow } = grokModelState(models);
        const effort = isRecord(opened) ? grokEffort(opened.configOptions) : undefined;
        this.listedModels = models;
        this.contextWindow = contextWindow;
        return { ...(model && { model }), ...(effort && { effort }), models: grokModels(models) };
    }

    protected usage(result: unknown): AgentChatSnapshot['usage'] {
        return grokUsage(result, this.contextWindow);
    }

    protected onExtensionNotification(method: string, update: Json): void {
        if (method === '_x.ai/session_notification' || method === '_x.ai/session/update')
            applyGrokExtensionUpdate(this.updates, update, (key) => this.requests.settle(key));
    }

    protected onExtensionRequest(connection: JsonRpcConnection, request: JsonRpcServerRequest) {
        if (request.method !== '_x.ai/ask_user_question') return false;
        const parameters = request.params;
        this.requests.askQuestion(
            connection,
            request.id,
            clip(stringField(parameters.toolCallId) ?? `question:${request.id}`, 200),
            parameters.questions,
            this.activeTurn?.id,
        );
        return true;
    }

    protected async steer(
        connection: JsonRpcConnection,
        turn: AcpActiveTurn,
        message: Omit<AgentChatMessageInput, 'delivery'>,
    ): Promise<'steered' | 'turnEnded'> {
        try {
            /**
             * Grok Build queues a second `session/prompt` behind the running turn; its interjection extension is the
             * equivalent of typing into the TUI mid-turn, so the message reaches the turn that is running.
             */
            await connection.request(
                '_x.ai/interject',
                { sessionId: this.sessionId, text: message.text, interjectionId: randomUUID() },
                TURN_REQUEST_TIMEOUT_MS,
            );
        } catch (error) {
            // The turn can end between the check and the interjection; the message then starts the next turn.
            if (!(error instanceof JsonRpcRequestError)) throw error;
            if (this.activeTurn)
                throw new CaxriError('CONFLICT', 'Grok Build could not take this message now');
            return 'turnEnded';
        }
        if (this.activeTurn !== turn) return 'turnEnded';
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
        return 'steered';
    }

    rewind(target: ChatRewindTarget): Promise<undefined> {
        return rewindGrokSession(this.requireConnection(), this.requireSessionId(), target);
    }

    async fork(target: ChatForkTarget | undefined): Promise<ChatFork> {
        const source = { sessionId: this.requireSessionId(), cwd: this.options.cwd };
        const connection = this.requireConnection();
        return {
            agentSessionId: await forkGrokSession(connection, source, target),
        };
    }

    async restoreFiles(target: ChatRewindTarget): Promise<void> {
        await rewindGrokSession(this.requireConnection(), this.requireSessionId(), target, 'files');
    }

    async configure({ model, effort }: AgentChatModelChange): Promise<void> {
        const connection = this.requireConnection();
        if (model) {
            const result = await connection.request(
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
        if (!effort) return;
        // Grok Build keeps the effort across a model switch, so it is set on its own, after the model.
        let result: unknown;
        try {
            result = await connection.request(
                'session/set_config_option',
                { sessionId: this.sessionId, configId: 'reasoning_effort', value: effort },
                TURN_REQUEST_TIMEOUT_MS,
            );
        } catch (error) {
            if (!(error instanceof JsonRpcRequestError)) throw error;
            throw new CaxriError('UNAVAILABLE', `Grok Build could not use ${effort} effort`);
        }
        const applied = isRecord(result) ? grokEffort(result.configOptions) : undefined;
        this.options.apply([{ op: 'state', state: { effort: applied ?? effort } }]);
    }
}

export const grokChatDriver: AgentChatDriver = {
    create: (host) => new GrokChatSession(host),
};
