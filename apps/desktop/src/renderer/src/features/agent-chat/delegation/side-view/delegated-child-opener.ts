import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { isChatTerminal } from '@caxri/protocol';

import { getBootstrap } from '../../../../stores/selectors';
import { sessionAgentTerminal } from '../../../session/session-agent-terminal';
import { openSession } from '../../../session/session-commands';
import { openAgentChatDelegation } from '../../tasks/agent-chat-task-opener';

/**
 * The Chat a delegated child opens in beside the asking Chat, or `undefined` when it must open as its own Session. Only
 * a consult (every delegation type, and `--consult`) opens beside: it takes no sidebar row, so the Side View is where
 * the user reads it. A Terminal child cannot: one PTY renders in one place, and the Session that owns it keeps it.
 */
export function besideChatDelegationTerminalId(
    session: SessionRecord | undefined,
    terminals: readonly TerminalRecord[],
): string | undefined {
    if (session?.createdByRelation !== 'consult') return undefined;
    const terminal = sessionAgentTerminal(session, terminals);
    return terminal && isChatTerminal(terminal) ? terminal.id : undefined;
}

/**
 * Opens a delegated child from the asking Chat: a consult's Chat in the Side View beside it, anything else as its own
 * Session.
 */
export function openDelegatedChild(sessionId: string): void {
    const bootstrap = getBootstrap();
    const session = bootstrap?.sessions.find((candidate) => candidate.id === sessionId);
    const terminalId = besideChatDelegationTerminalId(session, bootstrap?.terminals ?? []);
    if (terminalId) openAgentChatDelegation(terminalId);
    else openSession(sessionId);
}
