import type {
    AgentChatHistoryPage,
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatTurn,
} from './agent-chat-contract.js';
import { MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS } from './agent-chat-limits.js';

/**
 * The part of a Chat's conversation older than its live projection that a Client has read through
 * `agentChat.readHistory` (Desktop) or `mobile.agentChat.readHistory` (phone), oldest first. It belongs to one
 * `historyId`: a replaced conversation starts over. Shared by both Clients so their paging agrees.
 */
export interface AgentChatOlderHistory {
    historyId: string | undefined;
    items: readonly AgentChatItem[];
    turns: readonly AgentChatTurn[];
    /**
     * Whether a page was read. Until then, whether there is more follows the projection's own `truncated`.
     */
    isLoaded: boolean;
    /**
     * Another page precedes `items`; meaningful once `isLoaded`.
     */
    hasMore: boolean;
    /**
     * The conversation goes back further than Chat can show; meaningful once nothing more loads.
     */
    truncated: boolean;
    /**
     * A page is on its way, or the last request failed and waits for a retry.
     */
    status: 'idle' | 'loading' | 'failed';
}

export function emptyAgentChatOlderHistory(historyId: string | undefined): AgentChatOlderHistory {
    return {
        historyId,
        items: [],
        turns: [],
        isLoaded: false,
        hasMore: false,
        truncated: false,
        status: 'idle',
    };
}

/**
 * Whether scrolling back can load another page.
 */
export function hasOlderAgentChatHistory(
    history: AgentChatOlderHistory,
    snapshot: Pick<AgentChatSnapshot, 'truncated'> | undefined,
): boolean {
    return history.isLoaded ? history.hasMore : snapshot?.truncated === true;
}

/**
 * The item a page request reads before: the oldest one this Client holds.
 */
export function agentChatHistoryCursor(
    history: AgentChatOlderHistory,
    snapshot: Pick<AgentChatSnapshot, 'items'> | undefined,
): string | undefined {
    return history.items[0]?.id ?? snapshot?.items[0]?.id;
}

function mergeTurns(
    older: readonly AgentChatTurn[],
    newer: readonly AgentChatTurn[],
): readonly AgentChatTurn[] {
    if (older.length === 0) return newer;
    const known = new Set(newer.map((turn) => turn.id));
    const added = older.filter((turn) => !known.has(turn.id));
    return added.length === 0 ? newer : [...added, ...newer];
}

/**
 * Puts a page in front of what the Client already read. A page for another history is dropped, and an item the Client
 * already shows (a provider re-reporting an archived item) is not shown twice.
 */
export function prependAgentChatHistoryPage(
    history: AgentChatOlderHistory,
    page: AgentChatHistoryPage,
    liveItems: readonly AgentChatItem[],
): AgentChatOlderHistory {
    if (page.historyId !== history.historyId) return history;
    const shown = new Set([...history.items, ...liveItems].map((item) => item.id));
    const items = page.items.filter((item) => !shown.has(item.id));
    return {
        ...history,
        items: items.length === 0 ? history.items : [...items, ...history.items],
        turns: mergeTurns(page.turns, history.turns),
        isLoaded: true,
        hasMore: page.hasMore && page.items.length > 0,
        truncated: page.truncated,
    };
}

/**
 * How many pages one scroll-back reads at most while looking for a user message. A page holds at most
 * {@link MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS} items, so a long Agent turn can fill several pages with commands and tool
 * calls alone; past this bound the reader scrolls back again instead of one scroll-back pulling in a whole archive.
 */
export const MAX_AGENT_CHAT_HISTORY_PAGES_PER_LOAD = 10;

/**
 * Whether one scroll-back reads another page after `page` moved the history from `previous` to `next`. A page that ends
 * inside a turn shows Agent output without the request it answers, so reading goes on until a page brings a user
 * message, nothing older remains, a page adds nothing, or {@link MAX_AGENT_CHAT_HISTORY_PAGES_PER_LOAD} pages were
 * read.
 */
export function shouldReadOlderAgentChatHistoryPage(
    page: Pick<AgentChatHistoryPage, 'items'>,
    previous: AgentChatOlderHistory,
    next: AgentChatOlderHistory,
    pagesRead: number,
): boolean {
    return (
        pagesRead < MAX_AGENT_CHAT_HISTORY_PAGES_PER_LOAD &&
        next.hasMore &&
        next.items !== previous.items &&
        page.items.every((item) => item.type !== 'userMessage')
    );
}

/**
 * How many evicted items a Client keeps before it lets the oldest go. A Chat left open after one scroll-back would
 * otherwise mirror everything the Agent streams for as long as it stays mounted, while Server Core keeps its own
 * archive bounded. Dropped items stay readable: the cursor moves to the oldest kept item and the next scroll-back reads
 * them again from Server Core.
 */
export const MAX_AGENT_CHAT_RETAINED_HISTORY_ITEMS = 25 * MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS;

function trimRetainedHistory(history: AgentChatOlderHistory): AgentChatOlderHistory {
    const excess = history.items.length - MAX_AGENT_CHAT_RETAINED_HISTORY_ITEMS;
    // A page on its way reads before the current oldest item, so trimming now would open a gap above it.
    if (excess <= 0 || history.status !== 'idle') return history;
    const items = history.items.slice(excess);
    const turnIds = new Set(items.map((item) => item.turnId));
    return {
        ...history,
        items,
        turns: history.turns.filter((turn) => turnIds.has(turn.id)),
        isLoaded: true,
        hasMore: true,
    };
}

/**
 * Keeps what the live projection just evicted once the Client starts reading history, so the items between the pages
 * read and the projection never go missing while the user reads back. Before the first request there is nothing to
 * keep: it starts right before the projection. From the request on, an item evicted while the page is on its way sits
 * between the page and the projection, so it is kept too.
 *
 * `keepUnread` keeps evicted items before any request as well. The phone's window is small (one gateway frame), so a
 * long turn's output evicts rows the reader is looking at; without it those rows vanished from an open Chat and the few
 * left rendered at the bottom of an otherwise blank list.
 */
export function retainEvictedAgentChatItems(
    history: AgentChatOlderHistory,
    previous: Pick<AgentChatSnapshot, 'items' | 'turns'>,
    next: Pick<AgentChatSnapshot, 'items'>,
    { keepUnread = false }: { keepUnread?: boolean } = {},
): AgentChatOlderHistory {
    const isReading =
        keepUnread || history.isLoaded || history.status !== 'idle' || history.items.length > 0;
    if (!isReading || previous.items === next.items || previous.items.length === 0) return history;
    const first = next.items.at(0);
    if (first?.id === previous.items.at(0)?.id) return history;
    const kept = first ? previous.items.findIndex((item) => item.id === first.id) : -1;
    const evicted = previous.items.slice(0, kept === -1 ? previous.items.length : kept);
    if (evicted.length === 0) return history;
    const turnIds = new Set(evicted.map((item) => item.turnId));
    return trimRetainedHistory({
        ...history,
        items: [...history.items, ...evicted],
        turns: mergeTurns(
            history.turns,
            previous.turns.filter((turn) => turnIds.has(turn.id)),
        ),
    });
}

/**
 * Splits the history read so far into the settled part, which renders once and never changes while the conversation
 * streams, and the items that must render with the live projection: the start of the turn the projection begins inside,
 * so one turn is never split across two folds.
 */
export function splitAgentChatHistory(
    olderItems: readonly AgentChatItem[],
    /**
     * The turn of the live projection's first item.
     */
    turnId: string | undefined,
): { settled: readonly AgentChatItem[]; carried: readonly AgentChatItem[] } {
    let start = olderItems.length;
    while (turnId !== undefined && start > 0 && olderItems[start - 1]?.turnId === turnId)
        start -= 1;
    if (start === olderItems.length) return { settled: olderItems, carried: [] };
    return { settled: olderItems.slice(0, start), carried: olderItems.slice(start) };
}
