import { isChatTerminal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentChatService } from '../agent-chat';
import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { TerminalManager } from '../terminal';
import { didPasteAndSubmitAgentText } from '../terminal';
import { BotCompletionNotifier } from './completion-notice';
import type { BotCompletionNotifierOptions } from './completion-notice-contract';

async function sendChatNotice(
    agentChat: Pick<AgentChatService, 'send'>,
    terminalId: string,
    text: string,
    onDelivered?: (wasAccepted: boolean) => void,
): Promise<void> {
    try {
        // Not human input, like the PTY notice's `origin: 'delegation'` writes.
        await agentChat.send(terminalId, { text }, 'queue', 'delegation');
    } catch {
        onDelivered?.(false);
        return;
    }
    onDelivered?.(true);
}

/**
 * Binds the notifier to the Server's coordinator, Terminal manager, and Chat service. A PTY write fixes `origin:
 * 'delegation'` so the injected notice line itself never bumps the input epoch a later notice's own draft fence reads.
 *
 * A Chat Caxri Bot takes the notice as a Chat message instead. The same idle fence still runs first: a Chat composer
 * draft lives in the Client and is never touched by a sent message, so the input epoch simply never moves for a Chat,
 * but the finished-turn proof keeps one notice per idle turn instead of a queued message behind every completion.
 */
export function createBotCompletionNotifier({
    agentChat,
    coordinator,
    database,
    logger,
    terminals,
}: {
    agentChat: Pick<AgentChatService, 'send'>;
    coordinator: Pick<AgentCoordinator, 'hasIdleProof'>;
    /**
     * `getTerminal` comes first so the full record (its `surface`) is the overload `write` below resolves, not the
     * narrow one `CaxriBotRowReader` declares.
     */
    database: Pick<CaxriDatabase, 'getTerminal'> & BotCompletionNotifierOptions['database'];
    logger?: StructuredLogger;
    terminals: Pick<TerminalManager, 'inputEpoch' | 'writeAgentExact'>;
}): BotCompletionNotifier {
    return new BotCompletionNotifier({
        database,
        hasIdleProof: (terminalId, launchId, turnId) =>
            coordinator.hasIdleProof(terminalId, launchId, turnId),
        inputEpoch: (terminalId) => terminals.inputEpoch(terminalId),
        logger,
        write: (terminalId, text, launchId, onDelivered) => {
            const terminal = database.getTerminal(terminalId);
            if (terminal && isChatTerminal(terminal)) {
                void sendChatNotice(agentChat, terminalId, text, onDelivered);
                return true;
            }
            return didPasteAndSubmitAgentText(terminals, terminalId, text, launchId, onDelivered);
        },
    });
}
