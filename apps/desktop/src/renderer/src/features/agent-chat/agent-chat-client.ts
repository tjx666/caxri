import type { AgentChatPatch, AgentChatSnapshot } from '@caxri/protocol';
import { applyAgentChatPatch } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, isQueryMethod } from '../../queries/client';

function agentChatQueryKey(terminalId: string) {
    return caxriQueryKey('agentChat.read', { terminalId });
}

/**
 * Folds one transient `agentChat.patch` into the cached `agentChat.read` snapshot. The snapshot is only ever written
 * here and by the read itself, so the cache and the live stream share one revision chain; a gap invalidates the read
 * instead of rendering a projection that silently diverged from Server Core.
 *
 * A Chat nobody has open has no cached snapshot and is skipped without a read: patches for an unmounted Chat must not
 * wake its provider process.
 */
function applyAgentChatPatchToCache(queryClient: QueryClient, patch: AgentChatPatch): void {
    const queryKey = agentChatQueryKey(patch.terminalId);
    const state = queryClient.getQueryState(queryKey);
    if (!state) return;
    /**
     * A read in flight resolves to a revision at or past every patch emitted before it; any later patch chains from
     * that answer, so dropping patches until it lands loses nothing.
     */
    if (state.fetchStatus === 'fetching') return;
    const snapshot = queryClient.getQueryData<AgentChatSnapshot>(queryKey);
    // The cached read already includes this patch: it resolved after the patch was emitted.
    if (snapshot && patch.revision <= snapshot.revision) return;
    const next = snapshot && applyAgentChatPatch(snapshot, patch);
    if (next) queryClient.setQueryData(queryKey, next);
    // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
    else void queryClient.invalidateQueries({ queryKey, exact: true });
}

/**
 * Transient patches are not journaled, so any reconnect may have dropped some; every open Chat re-reads its snapshot.
 */
function invalidateAgentChatQueries(queryClient: QueryClient): void {
    // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
    void queryClient.invalidateQueries({
        predicate: (query) => isQueryMethod(query.queryKey, 'agentChat.read'),
    });
}

/**
 * Keeps every cached Chat projection current from Server events. Mounted once at the app root (see `app.tsx`) beside
 * `useRuntimeQueryInvalidation`, which owns invalidation for request/response reads.
 */
export function subscribeAgentChatPatches(queryClient: QueryClient): () => void {
    return caxri.onEvent((event) => {
        if (event.event === 'agentChat.patch')
            applyAgentChatPatchToCache(queryClient, event.payload);
        else if (event.event === 'host.connectionChanged') invalidateAgentChatQueries(queryClient);
    });
}
