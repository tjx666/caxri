import type { ServerEvent } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';

/**
 * `session.markRead`, `session.markDone`, and `session.markDoneMany`. `session.markRead`: clears a Session's unread
 * mark for the attention epoch the Client saw, and republishes its row only when that acknowledgement landed.
 */
export function createSessionMarkReadHandler(
    database: CaxriDatabase,
    send: (event: ServerEvent) => void,
): Pick<DomainHandlers, 'session.markDone' | 'session.markDoneMany' | 'session.markRead'> {
    return {
        'session.markRead': ({ sessionId, attentionGeneration }) => {
            const result = database.attentionMarks.read(sessionId, attentionGeneration);
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
            const result = database.attentionMarks.done(sessionId, attentionGeneration);
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
        /**
         * `session.markDoneMany`: the whole Needs attention queue in one transaction and one row republish, so clearing
         * a hundred Sessions refreshes every Client once instead of a hundred times.
         */
        'session.markDoneMany': ({ sessions }) => {
            const resolvedSessionIds = database.attentionMarks.doneMany(sessions);
            if (resolvedSessionIds.length > 0)
                send({
                    event: 'state.changed',
                    payload: { kind: 'records', sessionIds: resolvedSessionIds, terminalIds: [] },
                });
            return { resolvedSessionIds };
        },
    };
}
