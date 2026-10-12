import { logEventCatalog } from '@caxri/system';

import type { AgentChatSessionHost } from './chat-provider';
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
