import type { AgentChatDelegationNotice, AgentChatPatchOperation } from '@caxri/protocol';

import type { CaxriDatabase } from '../../db';
import { chatTextDigest } from '../chat-turn-answer';

/**
 * Every settlement notice starts with this tag (`formatSettlementNotice`), so a message without it is never hashed.
 */
const NOTICE_TAG = '[Caxri] ';

/**
 * Looks a message up among the notices Caxri delivered to this Terminal: the delivery table is keyed by the digest of
 * the exact text, so a person who types the same words does not match unless Caxri also wrote them here.
 */
export function deliveredNoticeOf(
    database: Pick<CaxriDatabase, 'agentDelegations'>,
    terminalId: string,
): (text: string) => AgentChatDelegationNotice | undefined {
    return (text) =>
        text.startsWith(NOTICE_TAG)
            ? database.agentDelegations.noticeDeliveries.delivered(
                  terminalId,
                  chatTextDigest(text.trim()),
              )
            : undefined;
}

/**
 * Marks each user message that is a settlement notice Caxri delivered to this Chat, live or replayed. The notice
 * reaches the provider as plain user input, so its history replays it as such; the delivery record, which outlives the
 * task record, is what lets a replay (and a Server Core restart) recognize it again. A message that is no delivered
 * notice is left as it is. The one gap: a notice older than the newest `MAX_NOTICE_DELIVERIES_PER_TERMINAL` deliveries
 * of the Terminal, or one delivered before its record could be written, replays as a plain message.
 */
export function stampDelegationNotices(
    operations: readonly AgentChatPatchOperation[],
    noticeOf: (text: string) => AgentChatDelegationNotice | undefined,
): readonly AgentChatPatchOperation[] {
    let stamped: AgentChatPatchOperation[] | undefined;
    for (const [index, operation] of operations.entries()) {
        if (
            operation.op !== 'upsertItem' ||
            operation.item.type !== 'userMessage' ||
            operation.item.delegatedTask ||
            operation.item.delegationNotice
        )
            continue;
        const delegationNotice = noticeOf(operation.item.text.trimStart());
        if (!delegationNotice) continue;
        stamped ??= [...operations];
        stamped[index] = { op: 'upsertItem', item: { ...operation.item, delegationNotice } };
    }
    return stamped ?? operations;
}
