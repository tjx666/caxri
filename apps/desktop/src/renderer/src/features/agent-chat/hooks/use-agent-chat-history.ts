import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';

import type { AgentChatOlderHistory, AgentChatSnapshot } from '@caxri/protocol';
import { hasOlderAgentChatHistory } from '@caxri/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
    agentChatHistoryQueryKey,
    cachedAgentChatHistory,
    loadOlderAgentChatHistory,
} from '../agent-chat-history-client';
import { agentChatEntryAtViewTop } from '../agent-chat-view-top';

export interface AgentChatHistory {
    history: AgentChatOlderHistory;
    hasMore: boolean;
    /**
     * Reads the page before the oldest item the pane holds. Calls while a page is on its way are ignored.
     */
    loadOlder: () => void;
}

/**
 * The history older than a Chat's live projection that the pane read while the user scrolled back (see
 * `agent-chat-history-client.ts`). The cache entry is written only by the loader and the eviction retention, so the
 * query never fetches: its function returns whatever is cached.
 *
 * A page goes in above what the reader is looking at, so the entry at the top of the view is put back where it was in
 * the same frame the page commits, before it paints. The correction runs once, for that commit only: holding on any
 * longer would pull the reader back from wherever they scroll next.
 */
export function useAgentChatHistory(
    terminalId: string,
    snapshot: AgentChatSnapshot | undefined,
    view: {
        scrollReference: RefObject<HTMLDivElement | null>;
        contentReference: RefObject<HTMLDivElement | null>;
        /**
         * Keeps the transcript from pinning itself to the end while the page goes in.
         */
        stopFollowing: () => void;
    },
): AgentChatHistory {
    const client = useQueryClient();
    const historyId = snapshot?.historyId;
    const { data: history } = useQuery({
        queryKey: agentChatHistoryQueryKey(terminalId, historyId),
        queryFn: () => cachedAgentChatHistory(client, terminalId, historyId),
        initialData: () => cachedAgentChatHistory(client, terminalId, historyId),
        staleTime: Infinity,
    });
    const { scrollReference, contentReference, stopFollowing } = view;
    const held = useRef<{ element: HTMLElement; offset: number }>(undefined);
    const holdViewTop = (): void => {
        const scroll = scrollReference.current;
        const content = contentReference.current;
        const element = scroll && content ? agentChatEntryAtViewTop(scroll, content) : undefined;
        if (!scroll || !element) return;
        stopFollowing();
        held.current = {
            element,
            offset: element.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
        };
    };
    useLayoutEffect(() => {
        const hold = held.current;
        const scroll = scrollReference.current;
        held.current = undefined;
        if (!hold || !scroll || !hold.element.isConnected) return;
        const offset =
            hold.element.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
        scroll.scrollTo({ top: scroll.scrollTop + offset - hold.offset });
    }, [history.items, scrollReference]);
    const loadOlder = (): void => {
        // eslint-disable-next-line no-void -- the loader records its own failure in the cached history
        void loadOlderAgentChatHistory(terminalId, holdViewTop);
    };
    return { history, hasMore: hasOlderAgentChatHistory(history, snapshot), loadOlder };
}
