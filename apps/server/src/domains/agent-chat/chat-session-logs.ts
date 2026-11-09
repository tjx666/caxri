import type { AgentChatMessageInput } from '@caxri/protocol';
import { currentObservationContext, logEventCatalog } from '@caxri/system';

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
