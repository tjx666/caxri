import { createHash } from 'node:crypto';

import type { AgentChatDelegationNotice, DelegationNoticeEvent } from '@caxri/protocol';

import { NOTICE_KINDS } from './kinds';
import type { NoticeItem } from './text';

/**
 * The closed event a Client turns into a status word for one item of a notice.
 */
export function noticeEvent(item: NoticeItem): DelegationNoticeEvent {
    return NOTICE_KINDS[item.kind].event(item);
}

/**
 * What a Chat stamps on a delivered notice message: each task, the Session it runs in, and the event. IDs and closed
 * values only, so the Client joins titles from its own Session data and never reads the message text.
 */
export function noticeDelivery(items: readonly NoticeItem[]): AgentChatDelegationNotice {
    const seen = new Set<string>();
    return {
        items: items
            .map((item) => ({
                delegationId: item.delegationId,
                sessionId: item.sessionId,
                event: noticeEvent(item),
            }))
            // Two questions of one task read as one row: the stamp does not tell them apart, and neither does a row.
            .filter(({ delegationId, event }) => {
                const key = `${delegationId}\0${event}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }),
    };
}

/**
 * The digest a Chat matches a message against: the exact text Caxri delivered, trimmed as the Chat trims it. The Chat
 * domain hashes a message the same way (`chatTextDigest` of the trimmed text) to look the notice up.
 */
export function noticeTextDigest(text: string): string {
    return createHash('sha256').update(text.trim()).digest('hex');
}
