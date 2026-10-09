import type { TerminalKind, TerminalRecord } from '@caxri/protocol';
import { canUseAgentChat, CaxriError } from '@caxri/protocol';

import type { AgentChatService } from './agent-chat';
import type { CaxriDatabase } from './db';

/**
 * Adds a Chat Terminal to an existing Session. A Chat has no PTY: its provider starts on first read instead of through
 * Terminal Host.
 */
export function createChatTerminalCreator(dependencies: {
    agentChat: Pick<AgentChatService, 'read'>;
    database: CaxriDatabase;
    newTerminalWorkingDirectory: (sessionId: string, requestedCwd?: string) => Promise<string>;
}) {
    const { agentChat, database, newTerminalWorkingDirectory } = dependencies;
    return async (
        sessionId: string,
        kind: TerminalKind,
        requestedCwd?: string,
    ): Promise<TerminalRecord> => {
        if (!canUseAgentChat(kind))
            throw new CaxriError('VALIDATION', 'This Agent does not support Chat');
        const cwd = await newTerminalWorkingDirectory(sessionId, requestedCwd);
        const terminal = database.createTerminal(sessionId, kind, cwd, 'chat');
        agentChat.read(terminal.id);
        return database.getTerminal(terminal.id) ?? terminal;
    };
}
