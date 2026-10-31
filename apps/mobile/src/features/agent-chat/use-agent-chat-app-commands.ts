import { useState } from 'react';

import type { AgentChatAppCommand, AgentProvider } from '@caxri/protocol';
import { canAgentChatPlan } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import type { MobileAgentChatSessionCommand } from './agent-chat-app-commands';
import {
    isMobileAgentChatSessionCommand,
    mobileAgentChatBuiltInActions,
} from './agent-chat-app-commands';
import type { AgentChatSettingsEntry } from './agent-chat-settings-sheet';
import type { AgentChatController } from './use-agent-chat';

/**
 * The composer sheet that is open: the Chat settings sheet at one of its sections, or the Session usage sheet. The
 * composer owns it so a `/` command and a chip open the same sheet.
 */
export type AgentChatComposerSheet = AgentChatSettingsEntry | 'usage';

/**
 * Caxri's own `/` commands on the phone, as Desktop's composer offers them: the rows the menu leads with, and running
 * one. `/model` and `/usage` open the sheets their chips open, `/plan` flips plan mode, and the Session commands go to
 * the Session screen (`onSessionCommand`), which owns Rename and the Session list. A command clears the draft once it
 * ran; `run` rejects, keeping the draft, when plan mode could not change.
 */
export const useAgentChatAppCommands = ({
    chat,
    configureReason,
    isPinned,
    onDraftChange,
    onSessionCommand,
    permissionReason,
    providerId,
}: {
    chat: Pick<AgentChatController, 'configure' | 'snapshot'>;
    configureReason: string | undefined;
    isPinned: boolean;
    onDraftChange: (draft: string) => void;
    /**
     * Runs a Session command; absent while the device may not manage Sessions.
     */
    onSessionCommand: ((command: MobileAgentChatSessionCommand) => void) | undefined;
    permissionReason: string | undefined;
    providerId: AgentProvider | undefined;
}) => {
    const { t } = useTranslation();
    const [sheet, setSheet] = useState<AgentChatComposerSheet | null>(null);
    const planMode = chat.snapshot?.planMode;
    const builtIn = mobileAgentChatBuiltInActions(
        {
            canConfigure: configureReason === undefined,
            canManageSession: onSessionCommand !== undefined,
            canPlan:
                permissionReason === undefined &&
                providerId !== undefined &&
                canAgentChatPlan(providerId) &&
                planMode !== undefined,
            hasUsage: chat.snapshot?.terminalId !== undefined,
            isPinned,
        },
        t,
    );
    const run = async (command: AgentChatAppCommand): Promise<void> => {
        // `/plan` keeps its draft until plan mode changed, so a failed switch can be retried as typed.
        if (command === 'plan') await chat.configure({ planMode: planMode !== true });
        onDraftChange('');
        if (isMobileAgentChatSessionCommand(command)) onSessionCommand?.(command);
        else if (command === 'model' || command === 'usage') setSheet(command);
    };
    return { builtIn, run, setSheet, sheet };
};
