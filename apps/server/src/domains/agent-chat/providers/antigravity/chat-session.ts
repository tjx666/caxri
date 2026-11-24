import type {
    AgentChatMessageInput,
    AgentChatModelChange,
    AgentChatPermission,
    AgentChatPermissionMode,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AntigravityConversationCut } from '../../../agents';
import { copyAntigravityConversation, readAntigravityUsage } from '../../../agents';
import { clip, isRecord, stringField } from '../../chat-items';
import { chatPermissionState, supportedChatPermission } from '../../chat-permissions';
import type {
    AgentChatDriver,
    AgentChatSessionHost,
    ChatFork,
    ChatForkTarget,
    ChatResumePoint,
    ChatRewindTarget,
} from '../../chat-provider';
import type { JsonRpcConnection, JsonRpcServerRequest } from '../../json-rpc-connection';
import { JsonRpcRequestError } from '../../json-rpc-connection';
import { antigravityChatSettings } from '../../launch-settings';
import type { AcpActiveTurn } from '../acp/dialect';
import { AcpChatSession, TURN_REQUEST_TIMEOUT_MS } from '../acp/session';
import { refinedUsageLimitOperations } from '../acp/turn-operations';
import {
    antigravityConfigState,
    antigravityMode,
    antigravityModels,
    antigravityPermission,
    antigravityProposedPlan,
    antigravitySystemPromptMeta,
    antigravityToolPresentation,
    antigravityUsage,
    isAntigravityUsageLimitError,
} from './items';
import { AntigravityPlanLimits, antigravityUsageLimit } from './plan-limits';
import { antigravityQuestions, mapAntigravityQuestion } from './questions';

/**
 * One live `agy acp` process: standard ACP with the model and its thinking level as config options, and session modes
 * for the permission level and plan mode, switched in place. Full access is the `--dangerously-skip-permissions` launch
 * flag, so a switch into or out of it restarts the process. A message sent mid-turn is a new `session/prompt`, which
 * `agy acp` takes as steering. `agy acp` picks the conversation's id in `session/new` and cannot cut or copy a
 * conversation, so rewind and fork copy its database (`copyAntigravityConversation`). See `docs/antigravity.md`.
 */
class AntigravityChatSession extends AcpChatSession {
    private readonly planLimits: AntigravityPlanLimits;

    /**
     * The permission level the process launched with; only crossing full access needs a restart.
     */
    private launchedPermission: AgentChatPermissionMode | undefined;

    private launchedPlanMode = false;

    /**
     * The latest `usage_update`, which the turn's usage reports in place of the prompt result's token total.
     */
    private context: { used: number; size: number } | undefined;

    /**
     * The `_meta` that appends Caxri's instructions to `agy`'s system prompt, set once `initialize` advertised it.
     */
    private sessionMeta: Record<string, unknown> | undefined;

    constructor(options: AgentChatSessionHost) {
        super(
            options,
            {
                provider: 'antigravity',
                label: 'Antigravity',
                presentation: antigravityToolPresentation,
                questions: antigravityQuestions,
                // Without it, `agy` never sends its `ask_question` questions (agy 1.5.16), and the turn ends unanswered.
                clientCapabilities: { elicitation: { form: {} } },
                configState: antigravityConfigState,
                // `agy acp` replays no turn ends, so every replayed turn finished.
                settledReplayTurns: 'completed',
                images: true,
                proposedPlan: antigravityProposedPlan,
                isUsageLimitError: isAntigravityUsageLimitError,
                // A command `agy` started as a daemon (`IsDaemon`) runs on by design; a foreground one is the turn's work.
                shouldHoldTurn: (call) =>
                    call.kind === 'execute' && call.rawInput.IsDaemon !== true,
                // `agy acp` first shipped in 1.5.0 (its changelog); an older `agy` has no ACP server at all.
                minimumVersion: '1.5.0',
            },
            options.agentSessionId,
        );
        this.planLimits = new AntigravityPlanLimits(() =>
            readAntigravityUsage({
                executable: options.executable,
                cwd: options.cwd,
                env: options.environment,
            }),
        );
    }

    /**
     * Sets one of `agy acp`'s config options, whose ids are `model` and `thought_level`.
     */
    private async setConfig(
        configId: 'model' | 'thought_level',
        value: string,
        failure: string,
    ): Promise<void> {
        const connection = this.requireConnection();
        let result: unknown;
        try {
            result = await connection.request(
                'session/set_config_option',
                { sessionId: this.requireSessionId(), configId, value },
                TURN_REQUEST_TIMEOUT_MS,
            );
        } catch (error) {
            if (!(error instanceof JsonRpcRequestError)) throw error;
            throw new CaxriError('UNAVAILABLE', failure);
        }
        const state = antigravityConfigState(isRecord(result) ? result.configOptions : undefined);
        this.options.apply([
            {
                op: 'state',
                state:
                    configId === 'model' ? { model: value, ...state } : { effort: value, ...state },
            },
        ]);
    }

    /**
     * Puts the conversation into the session mode `permission` names.
     */
    private async setMode(permission: AgentChatPermission): Promise<void> {
        try {
            await this.requireConnection().request(
                'session/set_mode',
                { sessionId: this.requireSessionId(), modeId: antigravityMode(permission) },
                TURN_REQUEST_TIMEOUT_MS,
            );
        } catch (error) {
            if (!(error instanceof JsonRpcRequestError)) throw error;
            throw new CaxriError('UNAVAILABLE', 'Antigravity could not switch its permission mode');
        }
    }

    /**
     * Copies the bound conversation, ending just before `target` when given (see `copyAntigravityConversation`). The
     * cut is checked against every user message the Chat shows from `target` on, steered ones included, since `agy`
     * records each as its own prompt.
     */
    private copy(target: ChatForkTarget | undefined) {
        const { agentEnvironment } = this.options;
        if (!agentEnvironment)
            throw new CaxriError('CONFLICT', 'This Antigravity conversation has no record to copy');
        // The live conversation, which a Chat's first turn picks after the session was created.
        const agentSessionId = this.requireSessionId();
        let cut: AntigravityConversationCut | undefined;
        if (target) {
            const { items } = this.options.read();
            const start = items.findIndex((item) => item.id === target.itemId);
            if (start === -1)
                throw new CaxriError('NOT_FOUND', 'That message is no longer in this Chat');
            cut = {
                userTexts: items
                    .slice(start)
                    .flatMap((item) => (item.type === 'userMessage' ? [item.text] : [])),
            };
        }
        return copyAntigravityConversation(agentEnvironment, agentSessionId, cut);
    }

    protected launchArguments(): {
        args: string[];
        permissionMode: AgentChatPermissionMode | undefined;
        planMode: boolean;
    } {
        const { args, isAutonomous } = antigravityChatSettings(this.options.launch);
        const chosen = supportedChatPermission('antigravity', this.options.permission);
        // Before session modes, a Chat without a chosen level edited without asking; it keeps doing so.
        const permissionMode =
            chosen.permissionMode ?? (isAutonomous ? 'fullAccess' : 'acceptEdits');
        this.launchedPermission = permissionMode;
        this.launchedPlanMode = chosen.planMode;
        return {
            args: [
                'acp',
                ...(permissionMode === 'fullAccess' ? ['--dangerously-skip-permissions'] : []),
                ...args,
            ],
            permissionMode,
            planMode: chosen.planMode,
        };
    }

    /**
     * `agy acp` remembers each conversation's mode, and a new one starts in `default`, so the mode the Chat's
     * permission names is set on every open.
     */
    protected async onOpened(): Promise<void> {
        await this.setMode({
            ...(this.launchedPermission && { permissionMode: this.launchedPermission }),
            planMode: this.launchedPlanMode,
        });
    }

    protected onInitialized(initialized: Record<string, unknown>): void {
        this.sessionMeta = antigravitySystemPromptMeta(initialized, this.options.instructions);
    }

    protected sessionParameters(): Record<string, unknown> {
        const parameters = super.sessionParameters();
        return this.sessionMeta ? { ...parameters, _meta: this.sessionMeta } : parameters;
    }

    protected openingState(opened: unknown): Partial<AgentChatSnapshot> {
        const configOptions = isRecord(opened) ? opened.configOptions : undefined;
        const usage = this.context && antigravityUsage(undefined, this.context);
        return {
            ...antigravityConfigState(configOptions),
            models: antigravityModels(configOptions),
            ...(usage && { usage }),
        };
    }

    protected usage(result: unknown): AgentChatSnapshot['usage'] {
        return antigravityUsage(result, this.context);
    }

    protected onContextUsage(used: number, size: number): void {
        this.context = { used, size };
        if (this.updates.isReplaying) return;
        const usage = antigravityUsage(undefined, this.context);
        if (usage) this.updates.applyState({ usage });
    }

    /**
     * Follows a mode `agy acp` reports, including one it switched to on its own, and saves it as the Chat's choice.
     */
    protected onModeChanged(modeId: string): void {
        const snapshot = this.options.read();
        const current: AgentChatPermission = {
            ...(snapshot.permissionMode && { permissionMode: snapshot.permissionMode }),
            planMode: snapshot.planMode ?? false,
        };
        const next = antigravityPermission(
            modeId,
            current,
            this.launchedPermission === 'fullAccess',
        );
        if (
            !next ||
            (next.permissionMode === current.permissionMode && next.planMode === current.planMode)
        )
            return;
        this.options.apply([
            {
                op: 'state',
                state: chatPermissionState('antigravity', next.permissionMode, next.planMode),
            },
        ]);
        this.options.onPermissionChanged(next);
    }

    protected async onUsageLimit(turnId: string): Promise<void> {
        try {
            const reading = await this.planLimits.read(true);
            const snapshot = this.options.read();
            const usageLimit = antigravityUsageLimit(reading, snapshot.model);
            this.options.apply(refinedUsageLimitOperations(snapshot, turnId, usageLimit));
        } catch {
            // A failed `/usage` read, or a Chat closed meanwhile, leaves the limit without its window.
        }
    }

    /**
     * `agy acp` asks its `ask_question` questions as a form elicitation keyed by the tool call. A form with no question
     * Caxri can show, or another elicitation mode, is declined, so the agent goes on instead of waiting.
     */
    protected onExtensionRequest(
        connection: JsonRpcConnection,
        request: JsonRpcServerRequest,
    ): boolean {
        if (request.method !== 'elicitation/create') return false;
        const parameters = request.params;
        const key = clip(stringField(parameters.toolCallId) ?? `question:${request.id}`, 200);
        const schema = parameters.requestedSchema;
        if (
            parameters.mode !== 'form' ||
            mapAntigravityQuestion(key, schema).questions.length === 0
        ) {
            this.options.onProtocolRejected('unsupportedRequest', request.method);
            connection.respond(request.id, { action: 'decline' });
            return true;
        }
        this.requests.askQuestion(connection, request.id, key, schema, this.activeTurn?.id);
        return true;
    }

    protected steer(
        connection: JsonRpcConnection,
        turn: AcpActiveTurn,
        message: Omit<AgentChatMessageInput, 'delivery'>,
    ): Promise<'steered'> {
        return Promise.resolve(this.supersedePrompt(connection, turn, message));
    }

    /**
     * Switches the session mode in place; crossing full access, a launch flag, needs a restart instead.
     */
    async setPermission(permission: AgentChatPermission): Promise<void | 'restartRequired'> {
        const isFullAccess = permission.permissionMode === 'fullAccess';
        if (isFullAccess !== (this.launchedPermission === 'fullAccess')) return 'restartRequired';
        await this.setMode(permission);
        this.options.apply([
            {
                op: 'state',
                state: chatPermissionState(
                    'antigravity',
                    permission.permissionMode,
                    permission.planMode,
                ),
            },
        ]);
    }

    readPlanLimits() {
        return this.planLimits.read();
    }

    async configure({ model, effort }: AgentChatModelChange): Promise<void> {
        if (model)
            await this.setConfig('model', model.id, `Antigravity could not switch to ${model.id}`);
        if (effort)
            await this.setConfig(
                'thought_level',
                effort,
                `Antigravity could not use ${effort} thinking`,
            );
    }

    /**
     * `agy acp` cannot cut a conversation, so the kept turns are copied into a new one the Chat switches to, and the
     * original stays whole (an earlier version keeps the replaced turns, as for every provider).
     */
    async rewind(target: ChatRewindTarget): Promise<ChatResumePoint> {
        const copied = await this.copy(target);
        return copied.kind === 'empty'
            ? { kind: 'fresh' }
            : { kind: 'switchTo', agentSessionId: copied.conversationId };
    }

    async fork(target: ChatForkTarget | undefined): Promise<ChatFork> {
        const copied = await this.copy(target);
        // Nothing comes before the message: the new Chat starts a conversation of its own.
        return { agentSessionId: copied.kind === 'empty' ? undefined : copied.conversationId };
    }
}

export const antigravityChatDriver: AgentChatDriver = {
    create: (host) => new AntigravityChatSession(host),
};
