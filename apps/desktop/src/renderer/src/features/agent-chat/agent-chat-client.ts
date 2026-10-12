import type {
    AgentChatPatch,
    AgentChatSnapshot,
    AgentChatTaskPatch,
    AgentChatTaskSnapshot,
} from '@caxri/protocol';
import { applyAgentChatPatch, applyAgentChatTaskPatch } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, isQueryMethod, queryClient } from '../../queries/client';
import { subscribeAgentChatHistoryRetention } from './agent-chat-history-client';

/**
 * Patches held per Chat or task while its read is in flight. Past this many the read is simply repeated, which costs
 * one round trip instead of an unbounded queue.
 */
const MAX_BUFFERED_PATCHES = 200;

function agentChatQueryKey(terminalId: string) {
    return caxriQueryKey('agentChat.read', { terminalId });
}

/**
 * The Chat's current snapshot for a one-off decision outside its pane: the live cache when the pane has read it (kept
 * current by `agentChat.patch`), otherwise one fresh `agentChat.read`.
 */
export async function readAgentChatSnapshot(terminalId: string): Promise<AgentChatSnapshot> {
    return (
        queryClient.getQueryData<AgentChatSnapshot>(agentChatQueryKey(terminalId)) ??
        caxri.request('agentChat.read', { terminalId })
    );
}

/**
 * The Chat's snapshot as the pane shows it right now, without a read: what a send decides from in the same tick.
 */
export function cachedAgentChatSnapshot(terminalId: string): AgentChatSnapshot | undefined {
    return queryClient.getQueryData<AgentChatSnapshot>(agentChatQueryKey(terminalId));
}

function agentChatTaskQueryKey(terminalId: string, taskId: string) {
    return caxriQueryKey('agentChat.readTask', { terminalId, taskId });
}

/**
 * One revision-chained projection the cache keeps current: the Chat itself (`agentChat.read` + `agentChat.patch`) or
 * one task (`agentChat.readTask` + `agentChat.taskPatch`). Both follow the same protocol, so one cache drives both.
 */
interface RevisionChannel<
    TPatch extends { revision: number },
    TSnapshot extends { revision: number },
> {
    method: 'agentChat.read' | 'agentChat.readTask';
    queryKey: (patch: TPatch) => readonly unknown[];
    /**
     * Stable identity of the projection a patch or cached query belongs to, for holding patches per projection.
     */
    key: (parameters: TPatch) => string;
    keyOfParameters: (parameters: unknown) => string;
    apply: (snapshot: TSnapshot, patch: TPatch) => TSnapshot | undefined;
}

const chatChannel: RevisionChannel<AgentChatPatch, AgentChatSnapshot> = {
    method: 'agentChat.read',
    queryKey: (patch) => agentChatQueryKey(patch.terminalId),
    key: (patch) => patch.terminalId,
    keyOfParameters: (parameters) => (parameters as { terminalId: string }).terminalId,
    apply: applyAgentChatPatch,
};

const taskChannel: RevisionChannel<AgentChatTaskPatch, AgentChatTaskSnapshot> = {
    method: 'agentChat.readTask',
    queryKey: (patch) => agentChatTaskQueryKey(patch.terminalId, patch.taskId),
    key: (patch) => `${patch.terminalId}\0${patch.taskId}`,
    keyOfParameters: (parameters) => {
        const { terminalId, taskId } = parameters as { terminalId: string; taskId: string };
        return `${terminalId}\0${taskId}`;
    },
    apply: applyAgentChatTaskPatch,
};

function invalidate(queryClient: QueryClient, queryKey: readonly unknown[]): void {
    // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
    void queryClient.invalidateQueries({ queryKey, exact: true });
}

/**
 * Folds one patch into the cached snapshot. Returns `false` when it does not continue the cached revision chain, in
 * which case the read is repeated instead of rendering a projection that silently diverged from Server Core.
 */
function didApplyToCache<
    TPatch extends { revision: number },
    TSnapshot extends { revision: number },
>(queryClient: QueryClient, channel: RevisionChannel<TPatch, TSnapshot>, patch: TPatch): boolean {
    const queryKey = channel.queryKey(patch);
    const snapshot = queryClient.getQueryData<TSnapshot>(queryKey);
    // The cached read already includes this patch: Server Core captured it after the patch was emitted.
    if (snapshot && patch.revision <= snapshot.revision) return true;
    const next = snapshot && channel.apply(snapshot, patch);
    if (!next) {
        invalidate(queryClient, queryKey);
        return false;
    }
    queryClient.setQueryData(queryKey, next);
    return true;
}

/**
 * Keeps cached snapshots of one channel current from its transient patch events. The snapshot is only ever written here
 * and by the read itself, so the cache and the live stream share one revision chain.
 *
 * A patch that arrives while a read is in flight is held, not dropped: Server Core may have captured the read just
 * before emitting it, and if that patch is the turn's last, nothing later would ever reveal the gap. Once the read
 * settles, held patches newer than its revision are replayed, and any break in the chain repeats the read.
 *
 * A projection nobody has open has no cached snapshot and is skipped without a read: patches for an unmounted Chat or a
 * closed task tab must not wake its provider process.
 */
function createRevisionPatchCache<
    TPatch extends { revision: number },
    TSnapshot extends { revision: number },
>(
    queryClient: QueryClient,
    channel: RevisionChannel<TPatch, TSnapshot>,
): {
    apply: (patch: TPatch) => void;
    dispose: () => void;
} {
    const held = new Map<string, { patches: TPatch[]; queryKey: readonly unknown[] }>();
    /**
     * Projections whose held patches overflowed; the read is repeated once the in-flight one settles.
     */
    const overflowed = new Map<string, readonly unknown[]>();
    const replay = (key: string, hasRead: boolean): void => {
        const patches = held.get(key)?.patches ?? [];
        const overflowKey = overflowed.get(key);
        held.delete(key);
        overflowed.delete(key);
        // A failed read has nothing to replay onto; its own retry or the next read starts a fresh chain.
        if (!hasRead) return;
        if (overflowKey) {
            invalidate(queryClient, overflowKey);
            return;
        }
        for (const patch of patches) if (!didApplyToCache(queryClient, channel, patch)) return;
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.query.state.fetchStatus !== 'idle') return;
        const [method, parameters] = event.query.queryKey as readonly unknown[];
        if (!isQueryMethod([method], channel.method)) return;
        const key = channel.keyOfParameters(parameters);
        if (held.has(key) || overflowed.has(key))
            replay(key, event.query.state.status === 'success');
    });
    return {
        apply: (patch) => {
            const key = channel.key(patch);
            const queryKey = channel.queryKey(patch);
            const state = queryClient.getQueryState(queryKey);
            if (!state) return;
            if (state.fetchStatus !== 'fetching') {
                didApplyToCache(queryClient, channel, patch);
                return;
            }
            if (overflowed.has(key)) return;
            const entry = held.get(key) ?? { patches: [], queryKey };
            if (entry.patches.length >= MAX_BUFFERED_PATCHES) {
                held.delete(key);
                overflowed.set(key, queryKey);
                return;
            }
            entry.patches.push(patch);
            held.set(key, entry);
        },
        dispose: () => {
            unsubscribe();
            held.clear();
            overflowed.clear();
        },
    };
}

/**
 * Keeps cached `agentChat.read` snapshots current from transient `agentChat.patch` events (see
 * {@link createRevisionPatchCache}).
 */
export function createAgentChatPatchCache(queryClient: QueryClient) {
    return createRevisionPatchCache(queryClient, chatChannel);
}

/**
 * Keeps cached `agentChat.readTask` snapshots current from transient `agentChat.taskPatch` events, with the same
 * revision protocol as the Chat itself.
 */
export function createAgentChatTaskPatchCache(queryClient: QueryClient) {
    return createRevisionPatchCache(queryClient, taskChannel);
}

/**
 * Transient patches are not journaled, so any reconnect may have dropped some; every open Chat and task tab re-reads
 * its snapshot.
 */
function invalidateAgentChatQueries(queryClient: QueryClient): void {
    // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
    void queryClient.invalidateQueries({
        predicate: (query) => isQueryMethod(query.queryKey, 'agentChat.read', 'agentChat.readTask'),
    });
}

/**
 * Keeps every cached Chat projection current from Server events. Mounted once at the app root (see `app.tsx`) beside
 * `useRuntimeQueryInvalidation`, which owns invalidation for request/response reads.
 */
export function subscribeAgentChatPatches(queryClient: QueryClient): () => void {
    const cache = createAgentChatPatchCache(queryClient);
    const taskCache = createAgentChatTaskPatchCache(queryClient);
    const unsubscribeHistory = subscribeAgentChatHistoryRetention(queryClient);
    const unsubscribe = caxri.onEvent((event) => {
        switch (event.event) {
            case 'agentChat.patch': {
                cache.apply(event.payload);
                break;
            }
            case 'agentChat.taskPatch': {
                taskCache.apply(event.payload);
                break;
            }
            case 'host.connectionChanged': {
                invalidateAgentChatQueries(queryClient);
                break;
            }
            default: {
                break;
            }
        }
    });
    return () => {
        unsubscribe();
        unsubscribeHistory();
        cache.dispose();
        taskCache.dispose();
    };
}
