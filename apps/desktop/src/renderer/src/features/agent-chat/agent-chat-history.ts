import type {
    AgentChatHistoryPage,
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatTurn,
} from '@caxri/protocol';

/**
 * Marks one entry of the history read back, rendered with `content-visibility: auto`.
 */
export const AGENT_CHAT_SETTLED_ENTRY_ATTRIBUTE = 'data-agent-chat-settled-entry';

/**
 * Marks the block holding every settled entry.
 */
export const AGENT_CHAT_SETTLED_TIMELINE_ATTRIBUTE = 'data-agent-chat-settled-timeline';

/**
 * Marks the history head above the transcript, which stays at the top while pages are put below it.
 */
export const AGENT_CHAT_HISTORY_HEAD_ATTRIBUTE = 'data-agent-chat-history-head';

/**
 * The part of a Chat's conversation older than its live projection that this pane has read through
 * `agentChat.readHistory`, oldest first. It belongs to one `historyId`: a replaced conversation starts over.
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
 * The item a page request reads before: the oldest one this pane holds.
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
 * Puts a page in front of what the pane already read. A page for another history is dropped, and an item the pane
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
 * Keeps what the live projection just evicted once the pane reads history, so the items between the pages read and the
 * projection never go missing while the user reads back. Before any page is read there is nothing to keep: the first
 * page starts right before the projection.
 */
export function retainEvictedAgentChatItems(
    history: AgentChatOlderHistory,
    previous: Pick<AgentChatSnapshot, 'items' | 'turns'>,
    next: Pick<AgentChatSnapshot, 'items'>,
): AgentChatOlderHistory {
    if (!history.isLoaded || previous.items === next.items || previous.items.length === 0)
        return history;
    const first = next.items.at(0);
    if (first?.id === previous.items.at(0)?.id) return history;
    const kept = first ? previous.items.findIndex((item) => item.id === first.id) : -1;
    const evicted = previous.items.slice(0, kept === -1 ? previous.items.length : kept);
    if (evicted.length === 0) return history;
    const turnIds = new Set(evicted.map((item) => item.turnId));
    return {
        ...history,
        items: [...history.items, ...evicted],
        turns: mergeTurns(
            history.turns,
            previous.turns.filter((turn) => turnIds.has(turn.id)),
        ),
    };
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
