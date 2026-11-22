import type {
    AgentChatMessageInput,
    AgentChatModelChange,
    AgentChatPermission,
    AgentChatPermissionMode,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { readAntigravityUsage } from '../../../agents';
import { isRecord } from '../../chat-items';
import { chatPermissionState, supportedChatPermission } from '../../chat-permissions';
import type { AgentChatDriver, AgentChatSessionHost, ChatFork } from '../../chat-provider';
import type { JsonRpcConnection } from '../../json-rpc-connection';
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
    antigravityToolPresentation,
    antigravityUsage,
    isAntigravityUsageLimitError,
} from './items';
import { AntigravityPlanLimits, antigravityUsageLimit } from './plan-limits';

/**
 * One live `agy acp` process: standard ACP with the model and its thinking level as config options, and session modes
 * for the permission level and plan mode, switched in place. Full access is the `--dangerously-skip-permissions` launch
 * flag, so a switch into or out of it restarts the process. A message sent mid-turn is a new `session/prompt`, which
 * `agy acp` takes as steering. `agy acp` picks the conversation's id in `session/new` and cannot rewind. See
 * `docs/antigravity.md`.
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

    constructor(options: AgentChatSessionHost) {
        super(
            options,
            {
                provider: 'antigravity',
                label: 'Antigravity',
                presentation: antigravityToolPresentation,
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

    rewind(): Promise<undefined> {
        return Promise.reject(
            new CaxriError('CONFLICT', 'Antigravity cannot rewind a conversation'),
        );
    }

    fork(): Promise<ChatFork> {
        return Promise.reject(new CaxriError('CONFLICT', 'Antigravity cannot fork a conversation'));
    }
}

export const antigravityChatDriver: AgentChatDriver = {
    create: (host) => new AntigravityChatSession(host),
};
