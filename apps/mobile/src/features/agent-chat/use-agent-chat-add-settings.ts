import { Box, Gauge, ShieldAlert, ShieldCheck } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { ComposerAddSetting } from '../sessions/components/composer-add-sheet';
import { agentChatAddSheetRows } from './agent-chat-add-sheet';
import { agentChatContextRing } from './agent-chat-session-usage';
import type { AgentChatController } from './use-agent-chat';
import type { AgentChatComposerSheet } from './use-agent-chat-app-commands';
import type { AgentChatSettingsState } from './use-agent-chat-settings';

/**
 * The Chat composer's add sheet rows (`agentChatAddSheetRows`) with their glyphs: a cube for the model, as LobeHub's
 * sheet draws it, the permission chip's own shield, and the usage gauge. A row opens its sheet through `onOpen` once
 * the add sheet has slid away.
 */
export const useAgentChatAddSettings = ({
    chat,
    onOpen,
    settings,
}: {
    chat: AgentChatController;
    onOpen: (sheet: AgentChatComposerSheet) => void;
    settings: AgentChatSettingsState;
}): ComposerAddSetting[] => {
    const { t } = useTranslation();
    const rows = agentChatAddSheetRows(
        {
            context: agentChatContextRing(chat.snapshot?.usage, t),
            hasUsage: chat.snapshot?.terminalId !== undefined,
            model: settings.modelTrigger,
            permission: settings.permissionTrigger,
        },
        t,
    );
    const icons = {
        model: Box,
        permission: settings.permissionTrigger?.isFullAccess ? ShieldAlert : ShieldCheck,
        usage: Gauge,
    } as const;
    return rows.map(({ entry, isEnabled, label, value }) => ({
        disabled: !isEnabled,
        icon: icons[entry],
        label,
        onPress: () => onOpen(entry),
        testID: `agent-chat-add-${entry}`,
        value,
    }));
};
