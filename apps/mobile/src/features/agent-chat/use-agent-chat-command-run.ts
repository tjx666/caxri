import { useState } from 'react';

import type { AgentChatCommand } from '@caxri/protocol';

import { agentChatCommandChoice } from './agent-chat-commands';
import type { AgentChatController } from './use-agent-chat';

/**
 * Runs a listed slash command from the phone's Chat composer, as Desktop's composer does. Unlike a message, a command
 * waits for Server Core (it can be refused, and it shows nothing optimistically), so the composer stays busy until it
 * lands. It clears only the draft: images stay for the next message, and during a turn Core queues the command rather
 * than steering with it.
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
    const [isRunning, setRunning] = useState(false);
    const run = async (command: { name: string; arguments?: string }): Promise<void> => {
        reportError(null);
        setRunning(true);
        try {
            await chat.runCommand(command);
            onDraftChange('');
        } catch {
            reportError(`/${command.name} did not run. Try again.`);
        } finally {
            setRunning(false);
        }
    };
    /**
     * A command without arguments runs as soon as it is chosen from the list; one with arguments goes to the draft.
     */
    const choose = (command: AgentChatCommand): void => {
        const choice = agentChatCommandChoice(command);
        if (choice.kind === 'complete') onDraftChange(choice.draft);
        // eslint-disable-next-line no-void -- The composer reports a failed command itself.
        else void run(choice.command);
    };
    return { choose, isRunning, run };
};
