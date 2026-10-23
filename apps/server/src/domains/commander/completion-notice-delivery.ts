import { isChatTerminal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentChatService } from '../agent-chat';
import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { TerminalManager } from '../terminal';
import { CommanderCompletionNotifier } from './completion-notice';
import type { CommanderCompletionNotifierOptions } from './completion-notice-contract';

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
 * Pastes the notice into a PTY Commander, then presses Enter once the paste is acknowledged. Claude Code reads input
 * arriving in one chunk as a paste, so an Enter inside that chunk only adds a line to the draft and the notice is never
 * sent. A bracketed paste followed by its own Enter submits on every provider, as a Composer submission does
 * (`submitAgentText`). Both writes keep `origin: 'delegation'`, so neither bumps the input epoch.
 */
function didWritePtyNotice(
    terminals: Pick<TerminalManager, 'writeAgentExact'>,
    terminalId: string,
    text: string,
    launchId: string,
    onDelivered?: (wasAccepted: boolean) => void,
): boolean {
    return terminals.writeAgentExact(
        terminalId,
        `\u{1B}[200~${text}\u{1B}[201~`,
        launchId,
        'delegation',
        (wasPasted) => {
            if (!wasPasted) {
                onDelivered?.(false);
                return;
            }
            // A rejected admission never calls back, so the notice is reported unconfirmed here.
            if (!terminals.writeAgentExact(terminalId, '\r', launchId, 'delegation', onDelivered))
                onDelivered?.(false);
        },
    );
}

/**
 * Binds the notifier to the Server's coordinator, Terminal manager, and Chat service. A PTY write fixes `origin:
 * 'delegation'` so the injected notice line itself never bumps the input epoch a later notice's own draft fence reads.
 *
 * A Chat Commander takes the notice as a Chat message instead. The same idle fence still runs first: a Chat composer
 * draft lives in the Client and is never touched by a sent message, so the input epoch simply never moves for a Chat,
 * but the finished-turn proof keeps one notice per idle turn instead of a queued message behind every completion.
 */
export function createCommanderCompletionNotifier({
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
     * narrow one `AgentCommanderRowReader` declares.
     */
    database: Pick<CaxriDatabase, 'getTerminal'> & CommanderCompletionNotifierOptions['database'];
    logger?: StructuredLogger;
    terminals: Pick<TerminalManager, 'inputEpoch' | 'writeAgentExact'>;
}): CommanderCompletionNotifier {
    return new CommanderCompletionNotifier({
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
            return didWritePtyNotice(terminals, terminalId, text, launchId, onDelivered);
        },
    });
}
