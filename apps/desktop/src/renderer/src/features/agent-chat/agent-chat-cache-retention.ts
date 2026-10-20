import type { QueryClient, QueryKey, QueryObserverOptions } from '@tanstack/react-query';

import { AGENT_CHAT_READ_QUERY_METHOD, isQueryMethod } from '../../queries/client';

/**
 * How many Chats nobody has on screen keep their cached conversation, following T3 Code's 16 remembered thread
 * timelines. A cached snapshot is what lets a Chat that left the Workbench keep-alive come back drawn at once instead
 * of behind a loading placeholder and another `agentChat.read`. Each one is bounded by the projection limits in
 * `agent-chat-limits.ts`, and `agentChat.patch` keeps it current whether or not it is shown.
 */
const AGENT_CHAT_CACHE_LIMIT = 16;

/**
 * Retains cached `agentChat.read` snapshots by recency instead of time. React Query's default would drop a Chat's
 * snapshot five minutes after its pane unmounted, so returning to a Chat after a coffee break read it again behind a
 * placeholder; with `gcTime: Infinity` (see `createCaxriQueryClient`) the snapshot stays until more than `limit` other
 * unobserved Chats were left after it.
 */
export function subscribeAgentChatCacheRetention(
    client: QueryClient,
    limit = AGENT_CHAT_CACHE_LIMIT,
): () => void {
    const cache = client.getQueryCache();
    /**
     * Query hashes of the unobserved Chat snapshots, the one left longest ago first.
     */
    const unobserved: string[] = [];
    // Snapshots already cached when this starts (a development remount) count as left before everything later.
    const cached = cache.findAll({ queryKey: [AGENT_CHAT_READ_QUERY_METHOD] });
    for (const query of cached) {
        if (query.getObserversCount() === 0) unobserved.push(query.queryHash);
    }
    return cache.subscribe((event) => {
        const { query } = event;
        if (!isQueryMethod(query.queryKey as QueryKey, AGENT_CHAT_READ_QUERY_METHOD)) return;
        const index = unobserved.indexOf(query.queryHash);
        const isUnobserved = event.type !== 'removed' && query.getObserversCount() === 0;
        if (isUnobserved && index !== -1) return;
        if (index !== -1) unobserved.splice(index, 1);
        if (!isUnobserved) return;
        unobserved.push(query.queryHash);
        while (unobserved.length > limit) {
            const evicted = cache.get(unobserved.shift()!);
            if (evicted) cache.remove(evicted);
        }
    });
}

/**
 * How a Chat pane's `agentChat.read` follows the cache while its Session is hidden behind keep-alive: it stays
 * subscribed but is told about no change, so streamed patches stop re-rendering a transcript nobody can see while the
 * Chat still counts as observed. `subscribed: false` would also stop the renders, but it detaches the observer, so the
 * retention above would count a kept-alive Chat as left and could drop the snapshot it is about to show again, and a
 * reconnect would no longer refetch it right away. Showing the Session re-renders the pane, which reads the latest
 * snapshot `agentChat.patch` kept current.
 */
export function agentChatReadFollowOptions(
    isSessionVisible: boolean,
): Pick<QueryObserverOptions, 'notifyOnChangeProps'> {
    return isSessionVisible ? {} : { notifyOnChangeProps: [] };
}
