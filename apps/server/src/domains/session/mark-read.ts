import type { ServerEvent } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';

/**
 * `session.markRead` and `session.markDone`. `session.markRead`: clears a Session's unread mark for the attention epoch
 * the Client saw, and republishes its row only when that acknowledgement landed.
 */
export function createSessionMarkReadHandler(
    database: CaxriDatabase,
    send: (event: ServerEvent) => void,
): Pick<DomainHandlers, 'session.markDone' | 'session.markRead'> {
    return {
        'session.markRead': ({ sessionId, attentionGeneration }) => {
            const result = database.markSessionAttentionRead(sessionId, attentionGeneration);
            if (result.acknowledged)
                send({
                    event: 'state.changed',
                    payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
                });
            return {
                acknowledged: result.acknowledged,
                sessionId: result.session.id,
                attentionGeneration: result.session.attentionGeneration,
                hasUnread: result.session.hasUnread,
            };
        },
        /**
         * `session.markDone`: resolves the Pending Attention generation the Client showed, so the Session leaves Needs
         * attention for Idle, and republishes its row only when that resolution landed.
         */
        'session.markDone': ({ sessionId, attentionGeneration }) => {
            const result = database.markSessionAttentionDone(sessionId, attentionGeneration);
            if (result.resolved)
                send({
                    event: 'state.changed',
                    payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
                });
            return {
                resolved: result.resolved,
                sessionId: result.session.id,
                attentionGeneration: result.session.attentionGeneration,
                hasPendingAttention: result.session.hasPendingAttention,
            };
        },
    };
}
