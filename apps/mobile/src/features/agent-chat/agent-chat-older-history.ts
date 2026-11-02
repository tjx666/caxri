import type {
    AgentChatHistoryPage,
    AgentChatOlderHistory,
    AgentChatSnapshot,
} from '@caxri/protocol';
import {
    emptyAgentChatOlderHistory,
    hasOlderAgentChatHistory,
    prependAgentChatHistoryPage,
    retainEvictedAgentChatItems,
    shouldReadOlderAgentChatHistoryPage,
} from '@caxri/protocol';

/**
 * The older pages a phone read for one Chat after its window changed from `previous` to `next`. A replaced conversation
 * (`historyId` changed) starts over; otherwise the items the new window no longer holds are kept, read back or not, so
 * rows already on screen never vanish when a long turn's output slides the small mobile window past them, and the
 * transcript never opens a gap between the pages and the window.
 */
export function syncAgentChatOlderHistory(
    history: AgentChatOlderHistory,
    previous: AgentChatSnapshot | undefined,
    next: AgentChatSnapshot | undefined,
): AgentChatOlderHistory {
    if (!next) return history;
    if (next.historyId !== history.historyId) return emptyAgentChatOlderHistory(next.historyId);
    if (!previous || previous.historyId !== next.historyId) return history;
    return retainEvictedAgentChatItems(history, previous, next, { keepUnread: true });
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
 * Whether one load reads another page after `page`. A scroll-back reads on until the turn's request
 * (`shouldReadOlderAgentChatHistoryPage`); a fill stops after one page, since the list asks again only while its rows
 * still leave the viewport short. Reading on landed several pages in a row above an opened Chat that followed its end,
 * and each one shifted the rows before the list returned to the end.
 */
export function shouldContinueAgentChatHistoryLoad(
    isFill: boolean,
    page: Pick<AgentChatHistoryPage, 'items'>,
    previous: AgentChatOlderHistory,
    next: AgentChatOlderHistory,
    pagesRead: number,
): boolean {
    return !isFill && shouldReadOlderAgentChatHistoryPage(page, previous, next, pagesRead);
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

/**
 * Whether an opened Chat's window starts inside its newest turn, so the request that turn answers is not on the phone.
 * The mobile window holds one 48 KiB frame, which a long running turn's commands and tool calls fill on their own.
 */
export function isMissingNewestTurnStart(snapshot: AgentChatSnapshot): boolean {
    if (!snapshot.truncated || snapshot.historyId === undefined) return false;
    const newestTurnId = snapshot.items.at(-1)?.turnId;
    if (newestTurnId === undefined) return false;
    return snapshot.items.every(
        (item) => !(item.turnId === newestTurnId && item.type === 'userMessage'),
    );
}

/**
 * Pages an opened Chat reads at most before it is shown. Each page is a round trip, over the Relay too, while the saved
 * copy or the loading state stays up; a turn longer than this opens as before, and scrolling back reads the rest.
 */
export const MAX_AGENT_CHAT_OPENING_PAGES = 3;

/**
 * Reads the pages above an opened Chat's window until one brings a user message, so the phone shows the newest turn's
 * request together with its work. The pages are applied once, not one by one: each page landing separately moved the
 * whole list, and an opened Chat jumped several times before it settled.
 */
export async function readAgentChatNewestTurnStart(
    snapshot: AgentChatSnapshot,
    readPage: (beforeItemId: string) => Promise<AgentChatHistoryPage>,
): Promise<AgentChatOlderHistory> {
    let history = emptyAgentChatOlderHistory(snapshot.historyId);
    for (let pagesRead = 1; pagesRead <= MAX_AGENT_CHAT_OPENING_PAGES; pagesRead += 1) {
        const cursor = history.items.at(0)?.id ?? snapshot.items.at(0)?.id;
        if (cursor === undefined || !hasOlderAgentChatHistory(history, snapshot)) break;
        // eslint-disable-next-line no-await-in-loop -- each page reads before the oldest item the previous one brought
        const page = await readPage(cursor);
        const next = prependAgentChatHistoryPage(history, page, snapshot.items);
        const continues = shouldReadOlderAgentChatHistoryPage(page, history, next, pagesRead);
        history = next;
        if (!continues) break;
    }
    return history;
}

/**
 * The history an opened Chat starts from: the pages read before it was first shown, while nothing was read since and
 * they belong to the same conversation.
 */
export function adoptOpeningAgentChatHistory(
    history: AgentChatOlderHistory,
    opening: AgentChatOlderHistory | undefined,
): AgentChatOlderHistory {
    if (!opening || history.isLoaded || history.items.length > 0) return history;
    return opening.historyId === history.historyId ? opening : history;
}
