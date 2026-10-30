import type {
    AgentChatModelChange,
    AgentChatPermissionMode,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { isRecord } from '../../chat-items';
import { supportedChatPermission } from '../../chat-permissions';
import type { AgentChatDriver, AgentChatSessionHost, ChatFork } from '../../chat-provider';
import { JsonRpcRequestError } from '../../json-rpc-connection';
import { antigravityChatSettings } from '../../launch-settings';
import { AcpChatSession, TURN_REQUEST_TIMEOUT_MS } from '../acp/session';
import {
    antigravityConfigState,
    antigravityModels,
    antigravityToolPresentation,
    antigravityUsage,
} from './items';

/**
 * One live `agy acp` process: standard ACP with the model and its thinking level as config options. `agy acp` picks the
 * conversation's id in `session/new`, has no way to steer a running turn or rewind, and fixes its permission at launch,
 * so a permission switch restarts it. See `docs/antigravity.md`.
 */
class AntigravityChatSession extends AcpChatSession {
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
            },
            options.agentSessionId,
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

    protected launchArguments(): {
        args: string[];
        permissionMode: AgentChatPermissionMode | undefined;
    } {
        const { args, isAutonomous } = antigravityChatSettings(this.options.launch);
        const permissionMode =
            supportedChatPermission('antigravity', this.options.permission).permissionMode ??
            (isAutonomous ? 'fullAccess' : 'acceptEdits');
        return {
            args: [
                'acp',
                ...(permissionMode === 'fullAccess' ? ['--dangerously-skip-permissions'] : []),
                ...args,
            ],
            permissionMode,
        };
    }

    protected openingState(opened: unknown): Partial<AgentChatSnapshot> {
        const configOptions = isRecord(opened) ? opened.configOptions : undefined;
        return {
            ...antigravityConfigState(configOptions),
            models: antigravityModels(configOptions),
        };
    }

    protected usage(result: unknown): AgentChatSnapshot['usage'] {
        return antigravityUsage(result);
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
