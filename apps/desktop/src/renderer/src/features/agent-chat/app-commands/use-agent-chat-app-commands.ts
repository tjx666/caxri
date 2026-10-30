import { useMemo, useSyncExternalStore } from 'react';

import { isPinnedSession } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { useSessions, useTerminal } from '../../../stores/selectors';
import { sessionForkBlocker } from '../../session/session-agent-commands';
import type { AgentChatComposerCommand } from '../composer/agent-chat-composer-commands';
import {
    canRunAgentChatComposerCommand,
    subscribeAgentChatComposerCommands,
} from '../composer/agent-chat-composer-commands';
import {
    agentChatAppCommandActions,
    parseAgentChatAppCommand,
} from '../composer-input/agent-chat-slash-commands';
import { runAgentChatAppCommand } from './agent-chat-app-commands';

/**
 * Whether this Chat's composer has registered `command`'s control, following it as the control mounts and unmounts.
 */
function useCanRunAgentChatComposerCommand(
    terminalId: string,
    command: AgentChatComposerCommand,
): boolean {
    return useSyncExternalStore(subscribeAgentChatComposerCommands, () =>
        canRunAgentChatComposerCommand(terminalId, command),
    );
}

/**
 * Caxri's app commands for one Chat (`AGENT_CHAT_APP_COMMANDS`): the rows its `/` menu offers, and `commandFor`, which
 * the composer checks a draft or a chosen row against before sending it. The composer controls (model picker, plan
 * mode, side chat) come from the registry those controls fill while they render, so a row appears once its control
 * does.
 */
export function useAgentChatAppCommands(terminalId: string) {
    const { t } = useTranslation();
    const terminal = useTerminal(terminalId);
    const session = useSessions()?.find((candidate) => candidate.id === terminal?.sessionId);
    const canChangeModel = useCanRunAgentChatComposerCommand(terminalId, 'changeModel');
    const canTogglePlanMode = useCanRunAgentChatComposerCommand(terminalId, 'togglePlanMode');
    const canOpenSideChat = useCanRunAgentChatComposerCommand(terminalId, 'openSideChat');
    const canFork = sessionForkBlocker(terminal) === undefined;
    const hasSession = session !== undefined;
    const isPinned = session !== undefined && isPinnedSession(session);
    const actions = useMemo(
        () =>
            agentChatAppCommandActions(
                {
                    canChangeModel,
                    canTogglePlanMode,
                    canOpenSideChat,
                    canFork,
                    hasSession,
                    isPinned,
                },
                t,
            ),
        [canChangeModel, canTogglePlanMode, canOpenSideChat, canFork, hasSession, isPinned, t],
    );
    return {
        actions,
        /**
         * What running `text` does when it is a bare app command this Chat offers, so the caller can settle the draft
         * before the command takes focus or the tab, and sends nothing to the Agent.
         */
        commandFor: (text: string): (() => void) | undefined => {
            const command = parseAgentChatAppCommand(text, actions);
            return command && (() => runAgentChatAppCommand(terminalId, command));
        },
    };
}
