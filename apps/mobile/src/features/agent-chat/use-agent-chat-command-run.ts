import { useState } from 'react';

import type { AgentAction } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { agentChatCommandChoice } from './agent-chat-commands';
import type { AgentChatController } from './use-agent-chat';

/**
 * Runs a listed slash command, or completes a skill, from the phone's Chat composer menu, as Desktop's composer does.
 * Unlike a message, a command waits for Server Core (it can be refused, and it shows nothing optimistically), so the
 * composer stays busy until it lands. It clears only the draft: images stay for the next message, and during a turn
 * Core queues the command rather than steering with it.
 */
export const useAgentChatCommandRun = ({
    chat,
    onDraftChange,
    reportError,
}: {
    chat: Pick<AgentChatController, 'runCommand'>;
    onDraftChange: (draft: string) => void;
    reportError: (message: string | null) => void;
}) => {
    const { t } = useTranslation();
    const [isRunning, setRunning] = useState(false);
    const run = async (command: { name: string; arguments?: string }): Promise<void> => {
        reportError(null);
        setRunning(true);
        try {
            await chat.runCommand(command);
            onDraftChange('');
        } catch {
            reportError(t('chat.commands.runFailed', { name: command.name }));
        } finally {
            setRunning(false);
        }
    };
    /**
     * A command without arguments runs as soon as it is chosen from the menu; one with arguments, or a skill, goes to
     * the draft.
     */
    const choose = (action: AgentAction): void => {
        const choice = agentChatCommandChoice(action);
        if (choice.kind === 'complete') onDraftChange(choice.draft);
        else void run(choice.command);
    };
    return { choose, isRunning, run };
};
