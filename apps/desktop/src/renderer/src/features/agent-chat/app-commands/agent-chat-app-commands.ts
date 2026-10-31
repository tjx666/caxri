import type { AgentChatAppCommand } from '@caxri/protocol';
import { isPinnedSession } from '@caxri/protocol';

import { getBootstrap } from '../../../stores/selectors';
import { openAgentStatusTab } from '../../agent-status/open-agent-status-tab';
import { archiveSession } from '../../session/session-archive-commands';
import { setSessionPinned } from '../../session/session-commands';
import { renameSession } from '../../session/session-rename-commands';
import { createTerminalForSession } from '../../terminal/terminal-commands';
import { openUsagePageForTerminal } from '../../usage/usage-page-request';
import { forkAgentChat } from '../agent-chat-commands';
import { runAgentChatComposerCommand } from '../composer/agent-chat-composer-commands';

/**
 * Runs one of Caxri's app commands for the Chat in `terminalId` (`AGENT_CHAT_APP_COMMANDS`). Each reaches the same
 * control its other entry point does, aimed at this Chat and its Session rather than whatever is active or selected.
 */
export function runAgentChatAppCommand(terminalId: string, command: AgentChatAppCommand): void {
    const terminal = getBootstrap()?.terminals.find((candidate) => candidate.id === terminalId);
    const sessionId = terminal?.sessionId;
    switch (command) {
        case 'status': {
            openAgentStatusTab(terminalId);
            return;
        }
        case 'usage': {
            openUsagePageForTerminal(terminalId);
            return;
        }
        case 'model': {
            runAgentChatComposerCommand(terminalId, 'changeModel');
            return;
        }
        case 'plan': {
            runAgentChatComposerCommand(terminalId, 'togglePlanMode');
            return;
        }
        case 'btw': {
            runAgentChatComposerCommand(terminalId, 'openSideChat');
            return;
        }
        case 'fork': {
            void forkAgentChat(terminalId);
            return;
        }
        case 'new': {
            if (terminal && sessionId)
                void createTerminalForSession(sessionId, terminal.kind, { surface: 'chat' });
            return;
        }
        case 'rename': {
            if (sessionId) renameSession(sessionId);
            return;
        }
        case 'archive': {
            if (sessionId) archiveSession(sessionId);
            return;
        }
        case 'pin': {
            const session = getBootstrap()?.sessions.find(
                (candidate) => candidate.id === sessionId,
            );
            if (session) setSessionPinned(session.id, !isPinnedSession(session));
        }
    }
}
