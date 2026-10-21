import type { AgentChatModelChange, AgentProvider } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import { requireChatTerminal } from './chat-launch';
import type { AgentChatProviderSession, AgentChatSessionHost } from './chat-provider';
import type { AgentChatServiceOptions } from './service-options';

/**
 * The provider session callbacks that only write a log event for one Chat Terminal: finished turns, rejected protocol
 * traffic, delivery checks after an unanswered request, and a fork the provider could not release.
 */
export function chatSessionLogCallbacks(
    { logger }: Pick<AgentChatServiceOptions, 'logger'>,
    terminalId: string,
): Pick<
    AgentChatSessionHost,
    'onDeliveryChecked' | 'onForkReleaseFailed' | 'onProtocolRejected' | 'onTurnFinished'
> {
    return {
        onTurnFinished: (status, durationMs) =>
            logger.write('info', logEventCatalog.agentChat.turnFinished, {
                fields: { terminalId, status, durationMs: durationMs ?? null },
            }),
        onProtocolRejected: (reason, method) =>
            logger.write('warn', logEventCatalog.agentChat.protocolRejected, {
                fields: { terminalId, reason, method: method.slice(0, 100) },
            }),
        onDeliveryChecked: (method, outcome) =>
            logger.write(
                outcome === 'unknown' ? 'warn' : 'info',
                logEventCatalog.agentChat.deliveryChecked,
                { fields: { terminalId, method, outcome } },
            ),
        onForkReleaseFailed: (reason) =>
            logger.write('debug', logEventCatalog.agentChat.forkReleaseFailed, {
                fields: { terminalId, reason },
            }),
    };
}

/**
 * Saves a model picker switch as the provider's default for new Chats (`saveDefaults`) and logs how it went
 * (`agent_chat.defaults_saved`). A failure only means the next new Chat starts without the choice, so it never
 * rejects.
 */
export async function saveChatDefaults(
    session: Pick<AgentChatProviderSession, 'saveDefaults'>,
    change: AgentChatModelChange,
    { database, logger }: Pick<AgentChatServiceOptions, 'database' | 'logger'>,
    terminalId: string,
): Promise<void> {
    if (!session.saveDefaults) return;
    let provider: AgentProvider | null = null;
    try {
        ({ provider } = requireChatTerminal(database, terminalId));
        const { keys, isOverridden } = await session.saveDefaults(change);
        if (keys.length === 0) return;
        logger.write(isOverridden ? 'warn' : 'info', logEventCatalog.agentChat.defaultsSaved, {
            fields: {
                terminalId,
                provider,
                outcome: isOverridden ? 'overridden' : 'saved',
                keys: keys.join(','),
            },
        });
    } catch {
        logger.write('warn', logEventCatalog.agentChat.defaultsSaved, {
            fields: { terminalId, provider, outcome: 'failed', keys: null },
        });
    }
}
