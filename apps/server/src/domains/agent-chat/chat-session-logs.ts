import type { AgentChatMessageInput, AgentChatModelChange, AgentProvider } from '@caxri/protocol';
import { currentObservationContext, logEventCatalog } from '@caxri/system';

import { requireChatTerminal } from './chat-launch';
import type { AgentChatProviderSession, AgentChatSessionHost } from './chat-provider';
import type { ChatState } from './chat-states';
import type { AgentChatServiceOptions } from './service-options';

/**
 * Starts a turn and remembers the Client request that started it, so `agent_chat.turn_finished` can point back to that
 * request after the provider's own records have long left its trace. A send outside a request (queue dispatch,
 * automatic continuation) records `null`.
 */
export function sendStartingTurn(
    session: Pick<AgentChatProviderSession, 'send'>,
    state: Pick<ChatState, 'turnStartRequestId'>,
    message: Omit<AgentChatMessageInput, 'delivery'>,
): Promise<void> {
    state.turnStartRequestId = currentObservationContext().requestId ?? null;
    return session.send(message);
}

/**
 * The provider session callbacks that only write a log event for one Chat Terminal: finished turns, rejected protocol
 * traffic, delivery checks after an unanswered request, provider feedback shown in the Chat, and a fork the provider
 * could not release.
 */
export function chatSessionLogCallbacks(
    { logger }: Pick<AgentChatServiceOptions, 'logger'>,
    terminalId: string,
    state: Pick<ChatState, 'turnStartRequestId'>,
): Pick<
    AgentChatSessionHost,
    | 'onDeliveryChecked'
    | 'onForkReleaseFailed'
    | 'onProtocolRejected'
    | 'onProviderNotice'
    | 'onTurnFinished'
> {
    return {
        onTurnFinished: (status, durationMs, turnId) => {
            const startRequestId = state.turnStartRequestId ?? null;
            state.turnStartRequestId = undefined;
            logger.write('info', logEventCatalog.agentChat.turnFinished, {
                fields: {
                    terminalId,
                    status,
                    durationMs: durationMs ?? null,
                    turnId,
                    startRequestId,
                },
            });
        },
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
        onProviderNotice: (notice) =>
            logger.write('info', logEventCatalog.agentChat.providerNotice, {
                fields: { terminalId, ...notice },
            }),
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
