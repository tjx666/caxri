import type { AgentChatOlderHistory, AgentChatSnapshot } from '@caxri/protocol';
import {
    emptyAgentChatOlderHistory,
    hasOlderAgentChatHistory,
    retainEvictedAgentChatItems,
} from '@caxri/protocol';

/**
 * The older pages a phone read for one Chat after its window changed from `previous` to `next`. A replaced conversation
 * (`historyId` changed) starts over; otherwise the items the new window no longer holds are kept once the phone has
 * started reading back, so the transcript never opens a gap between the pages and the window.
 */
export function syncAgentChatOlderHistory(
    history: AgentChatOlderHistory,
    previous: AgentChatSnapshot | undefined,
    next: AgentChatSnapshot | undefined,
): AgentChatOlderHistory {
    if (!next) return history;
    if (next.historyId !== history.historyId) return emptyAgentChatOlderHistory(next.historyId);
    if (!previous || previous.historyId !== next.historyId) return history;
    return retainEvictedAgentChatItems(history, previous, next);
}

/**
 * Whether the phone can ask for another page. `mobile.agentChat.readHistory` pages belong to a `historyId`, so a Chat
 * that has not bound a conversation yet has nothing to page.
 */
export function canLoadOlderAgentChatHistory(
    history: AgentChatOlderHistory,
    snapshot: AgentChatSnapshot | undefined,
): boolean {
    return snapshot?.historyId !== undefined && hasOlderAgentChatHistory(history, snapshot);
}

/**
 * The window with the older pages in front of it, as one snapshot the timeline folds turns over. An older item the
 * window also holds is shown once, from the window. `truncated` keeps the snapshot's meaning: older history exists that
 * this list does not show, so the oldest turn may be missing its start.
 */
export function mergeAgentChatOlderHistory(
    snapshot: AgentChatSnapshot,
    history: AgentChatOlderHistory,
): AgentChatSnapshot {
    const canLoad = canLoadOlderAgentChatHistory(history, snapshot);
    const truncated = canLoad || (history.isLoaded ? history.truncated : snapshot.truncated);
    if (history.items.length === 0)
        return truncated === snapshot.truncated ? snapshot : { ...snapshot, truncated };
    const live = new Set(snapshot.items.map((item) => item.id));
    const older = history.items.filter((item) => !live.has(item.id));
    const knownTurns = new Set(snapshot.turns.map((turn) => turn.id));
    return {
        ...snapshot,
        items: [...older, ...snapshot.items],
        turns: [...history.turns.filter((turn) => !knownTurns.has(turn.id)), ...snapshot.turns],
        truncated,
    };
}
