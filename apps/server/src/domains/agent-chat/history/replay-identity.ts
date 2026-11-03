import type { AgentChatSnapshot } from '@caxri/protocol';

/**
 * The conversation Clients page through: its `historyId` and every item id it holds, archived ones first.
 */
export interface ChatHistoryIdentity {
    historyId: string | undefined;
    itemIds: readonly string[];
}

/**
 * A projection's identity from its snapshot and the ids its archive holds.
 */
export const chatHistoryIdentity = (
    snapshot: Pick<AgentChatSnapshot, 'historyId' | 'items'>,
    archivedIds: readonly string[],
): ChatHistoryIdentity => ({
    historyId: snapshot.historyId,
    itemIds: [...archivedIds, ...snapshot.items.map((item) => item.id)],
});

/**
 * Whether a history replay rebuilt the conversation Clients already page through, so it keeps its `historyId`. A Chat
 * resumed after idle suspension replays its whole thread with a `reset`; a new `historyId` there told every Client the
 * conversation was replaced, so a phone that had just opened the Chat dropped the older pages it read to show the
 * newest turn's request, and its list jumped a moment after it appeared. The replay counts as the same conversation
 * when every item Clients could have read comes back in the same order, possibly after older ones the archive had
 * dropped and before newer ones. A rewind drops items, so it still starts a new history.
 */
export function isSameChatHistory(
    previous: ChatHistoryIdentity,
    next: Pick<ChatHistoryIdentity, 'itemIds'>,
): boolean {
    if (previous.historyId === undefined || previous.itemIds.length === 0) return false;
    const start = next.itemIds.indexOf(previous.itemIds[0]);
    if (start === -1 || next.itemIds.length - start < previous.itemIds.length) return false;
    return previous.itemIds.every((id, index) => next.itemIds[start + index] === id);
}
