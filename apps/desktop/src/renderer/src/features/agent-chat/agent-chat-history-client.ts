import type { AgentChatSnapshot } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, isQueryMethod, queryClient } from '../../queries/client';
import type { AgentChatOlderHistory } from './agent-chat-history';
import {
    agentChatHistoryCursor,
    emptyAgentChatOlderHistory,
    hasOlderAgentChatHistory,
    prependAgentChatHistoryPage,
    retainEvictedAgentChatItems,
} from './agent-chat-history';

/**
 * Where the history a Chat pane read back is cached: beside the projection, one entry per `historyId`, so a replaced
 * conversation starts empty and a remounted pane keeps what it already read.
 */
export function agentChatHistoryQueryKey(
    terminalId: string,
    historyId: string | undefined,
): readonly unknown[] {
    return ['agentChat.history', terminalId, historyId ?? null];
}

/**
 * The cached history for the projection's current `historyId`, or an empty one.
 */
export function cachedAgentChatHistory(
    client: QueryClient,
    terminalId: string,
    historyId: string | undefined,
): AgentChatOlderHistory {
    return (
        client.getQueryData<AgentChatOlderHistory>(
            agentChatHistoryQueryKey(terminalId, historyId),
        ) ?? emptyAgentChatOlderHistory(historyId)
    );
}

const loading = new Set<string>();

/**
 * Reads the page before the oldest item the pane holds and puts it in front. `onBeforePrepend` runs while the DOM still
 * shows the old transcript, so the view can hold the entry the reader looks at in place. A call while the Chat's page
 * is on its way does nothing.
 */
export async function loadOlderAgentChatHistory(
    terminalId: string,
    onBeforePrepend: () => void,
): Promise<void> {
    const snapshot = queryClient.getQueryData<AgentChatSnapshot>(
        caxriQueryKey('agentChat.read', { terminalId }),
    );
    const { historyId } = snapshot ?? {};
    const queryKey = agentChatHistoryQueryKey(terminalId, historyId);
    const history = cachedAgentChatHistory(queryClient, terminalId, historyId);
    const cursor = agentChatHistoryCursor(history, snapshot);
    if (!cursor || loading.has(terminalId) || !hasOlderAgentChatHistory(history, snapshot)) return;
    loading.add(terminalId);
    const update = (change: (current: AgentChatOlderHistory) => AgentChatOlderHistory): void => {
        queryClient.setQueryData<AgentChatOlderHistory>(queryKey, (current) =>
            change(current ?? emptyAgentChatOlderHistory(historyId)),
        );
    };
    update((current) => ({ ...current, status: 'loading' }));
    try {
        const page = await caxri.request('agentChat.readHistory', {
            terminalId,
            beforeItemId: cursor,
        });
        if (page.items.length > 0 && page.historyId === historyId) onBeforePrepend();
        const live =
            queryClient.getQueryData<AgentChatSnapshot>(
                caxriQueryKey('agentChat.read', { terminalId }),
            )?.items ?? [];
        update((current) => ({
            ...prependAgentChatHistoryPage(current, page, live),
            status: 'idle',
        }));
    } catch {
        update((current) => ({ ...current, status: 'failed' }));
    } finally {
        loading.delete(terminalId);
    }
}

/**
 * Moves the items each Chat projection evicts into the history its pane read back, whichever way the projection changed
 * (a patch or a full re-read). Without it, a conversation that keeps streaming while the user reads back would open a
 * gap between the pages read and the projection.
 */
export function subscribeAgentChatHistoryRetention(client: QueryClient): () => void {
    const seen = new Map<string, AgentChatSnapshot>();
    return client.getQueryCache().subscribe((event) => {
        const queryKey = event.query.queryKey as readonly unknown[];
        if (!isQueryMethod(queryKey, 'agentChat.read')) return;
        const { terminalId } = queryKey[1] as { terminalId: string };
        if (event.type === 'removed') {
            seen.delete(terminalId);
            return;
        }
        if (event.type !== 'updated') return;
        const next = event.query.state.data as AgentChatSnapshot | undefined;
        const previous = seen.get(terminalId);
        if (!next || next === previous) return;
        seen.set(terminalId, next);
        if (!previous || previous.historyId !== next.historyId) return;
        const historyKey = agentChatHistoryQueryKey(terminalId, next.historyId);
        const history = client.getQueryData<AgentChatOlderHistory>(historyKey);
        if (!history) return;
        const retained = retainEvictedAgentChatItems(history, previous, next);
        if (retained !== history) client.setQueryData(historyKey, retained);
    });
}
