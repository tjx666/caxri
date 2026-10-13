import type { ServerEvent } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';

/**
 * `session.markRead`: clears a Session's unread mark for the attention epoch the Client saw, and republishes its row
 * only when that acknowledgement landed.
 */
export function createSessionMarkReadHandler(
    database: CaxriDatabase,
    send: (event: ServerEvent) => void,
): Pick<DomainHandlers, 'session.markRead'> {
    return {
        'session.markRead': ({ sessionId, attentionEpoch }) => {
            const result = database.markSessionAttentionRead(sessionId, attentionEpoch);
            if (result.acknowledged)
                send({
                    event: 'state.changed',
                    payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
                });
            return {
                acknowledged: result.acknowledged,
                sessionId: result.session.id,
                attentionEpoch: result.session.attentionEpoch,
                hasUnread: result.session.hasUnread,
            };
        },
    };
}
