import type { AgentProvider } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { agentChatModelTrigger } from './agent-chat-model-choice';
import { agentChatPermissionTrigger } from './agent-chat-permission-choice';
import { visibleAgentChatPermissionTrigger } from './agent-chat-settings-trigger';
import type { AgentChatController } from './use-agent-chat';
import {
    useAgentChatModelSelection,
    useAgentChatPermissionSelection,
} from './use-agent-chat-choice';

/**
 * The Chat's model and permission selections with the triggers that name them. The composer reads it once and shares it
 * between the expanded capsule's chips (`AgentChatSettingsChips`) and the add sheet rows (`useAgentChatAddSettings`),
 * so both name the same model and level.
 */
export const useAgentChatSettings = ({
    chat,
    configureReason,
    permissionReason,
    provider,
}: {
    chat: AgentChatController;
    /**
     * Why the device cannot configure the Chat now; see `agentChatDisabledReason` with `action: 'configure'`.
     */
    configureReason: string | undefined;
    /**
     * Why the device cannot change permissions now; see `agentChatDisabledReason` with `action: 'permission'`.
     */
    permissionReason: string | undefined;
    provider: AgentProvider | undefined;
}) => {
    const { t } = useTranslation();
    const model = useAgentChatModelSelection(chat, configureReason);
    const permission = useAgentChatPermissionSelection(chat, permissionReason);
    const modelTrigger = agentChatModelTrigger(model.snapshot, configureReason === undefined, t);
    const permissionTrigger = agentChatPermissionTrigger(
        permission.snapshot,
        provider,
        permissionReason === undefined,
        t,
    );
    const permissionChip = visibleAgentChatPermissionTrigger({
        hasModelTrigger: modelTrigger !== undefined,
        mode: permission.snapshot?.permissionMode,
        provider,
        trigger: permissionTrigger,
    });
    return {
        configureReason,
        model,
        modelTrigger,
        permission,
        permissionChip,
        permissionReason,
        permissionTrigger,
        provider,
    };
};

export type AgentChatSettingsState = ReturnType<typeof useAgentChatSettings>;
