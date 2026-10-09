import type { AgentChatPatch, AgentChatSnapshot } from '@caxri/protocol';
import { applyAgentChatPatch } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, isQueryMethod } from '../../queries/client';

/**
 * Patches held per Chat while its read is in flight. Past this many the read is simply repeated, which costs one round
 * trip instead of an unbounded queue.
 */
const MAX_BUFFERED_PATCHES = 200;

function agentChatQueryKey(terminalId: string) {
    return caxriQueryKey('agentChat.read', { terminalId });
}

function invalidateAgentChat(queryClient: QueryClient, terminalId: string): void {
    // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
    void queryClient.invalidateQueries({ queryKey: agentChatQueryKey(terminalId), exact: true });
}

/**
 * Folds one patch into the cached snapshot. Returns `false` when it does not continue the cached revision chain, in
 * which case the read is repeated instead of rendering a projection that silently diverged from Server Core.
 */
function didApplyToCache(queryClient: QueryClient, patch: AgentChatPatch): boolean {
    const queryKey = agentChatQueryKey(patch.terminalId);
    const snapshot = queryClient.getQueryData<AgentChatSnapshot>(queryKey);
    // The cached read already includes this patch: Server Core captured it after the patch was emitted.
    if (snapshot && patch.revision <= snapshot.revision) return true;
    const next = snapshot && applyAgentChatPatch(snapshot, patch);
    if (!next) {
        invalidateAgentChat(queryClient, patch.terminalId);
        return false;
    }
    queryClient.setQueryData(queryKey, next);
    return true;
}

/**
 * Keeps cached `agentChat.read` snapshots current from transient `agentChat.patch` events. The snapshot is only ever
 * written here and by the read itself, so the cache and the live stream share one revision chain.
 *
 * A patch that arrives while a read is in flight is held, not dropped: Server Core may have captured the read just
 * before emitting it, and if that patch is the turn's last, nothing later would ever reveal the gap. Once the read
 * settles, held patches newer than its revision are replayed, and any break in the chain repeats the read.
 *
 * A Chat nobody has open has no cached snapshot and is skipped without a read: patches for an unmounted Chat must not
 * wake its provider process.
 */
export function createAgentChatPatchCache(queryClient: QueryClient): {
    apply: (patch: AgentChatPatch) => void;
    dispose: () => void;
} {
    const held = new Map<string, AgentChatPatch[]>();
    /**
     * Chats whose held patches overflowed; the read is repeated once the in-flight one settles.
     */
    const overflowed = new Set<string>();
    const replay = (terminalId: string, hasRead: boolean): void => {
        const patches = held.get(terminalId) ?? [];
        const hasOverflowed = overflowed.has(terminalId);
        held.delete(terminalId);
        overflowed.delete(terminalId);
        // A failed read has nothing to replay onto; its own retry or the next read starts a fresh chain.
        if (!hasRead) return;
        if (hasOverflowed) {
            invalidateAgentChat(queryClient, terminalId);
            return;
        }
        for (const patch of patches) if (!didApplyToCache(queryClient, patch)) return;
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.query.state.fetchStatus !== 'idle') return;
        const [method, parameters] = event.query.queryKey as readonly unknown[];
        if (!isQueryMethod([method], 'agentChat.read')) return;
        const { terminalId } = parameters as { terminalId: string };
        if (held.has(terminalId) || overflowed.has(terminalId))
            replay(terminalId, event.query.state.status === 'success');
    });
    return {
        apply: (patch) => {
            const { terminalId } = patch;
            const state = queryClient.getQueryState(agentChatQueryKey(terminalId));
            if (!state) return;
            if (state.fetchStatus !== 'fetching') {
                didApplyToCache(queryClient, patch);
                return;
            }
            if (overflowed.has(terminalId)) return;
            const patches = held.get(terminalId) ?? [];
            if (patches.length >= MAX_BUFFERED_PATCHES) {
                held.delete(terminalId);
                overflowed.add(terminalId);
                return;
            }
            patches.push(patch);
            held.set(terminalId, patches);
        },
        dispose: () => {
            unsubscribe();
            held.clear();
            overflowed.clear();
        },
    };
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
    const cache = createAgentChatPatchCache(queryClient);
    const unsubscribe = caxri.onEvent((event) => {
        if (event.event === 'agentChat.patch') cache.apply(event.payload);
        else if (event.event === 'host.connectionChanged') invalidateAgentChatQueries(queryClient);
    });
    return () => {
        unsubscribe();
        cache.dispose();
    };
}
