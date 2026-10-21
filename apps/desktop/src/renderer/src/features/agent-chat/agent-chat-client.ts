import type {
    AgentChatPatch,
    AgentChatSnapshot,
    AgentChatTaskPatch,
    AgentChatTaskSnapshot,
    RevisionConvergence,
    RevisionDecision,
} from '@caxri/protocol';
import {
    applyAgentChatPatch,
    applyAgentChatTaskPatch,
    createRevisionConvergence,
} from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, isQueryMethod, queryClient } from '../../queries/client';
import { subscribeAgentChatCacheRetention } from './agent-chat-cache-retention';
import { subscribeAgentChatHistoryRetention } from './transcript/agent-chat-history-client';
import {
    invalidateAgentChatWaiting,
    isAgentChatWaitingPatch,
} from './waiting/agent-chat-waiting-client';

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
 * Carries out a core decision on the cache: the React Query adapter owns the snapshot container and invalidation, the
 * shared revision convergence core owns every decision about the chain.
 */
function runDecision<TSnapshot extends { revision: number }>(
    queryClient: QueryClient,
    queryKey: readonly unknown[],
    decision: RevisionDecision<TSnapshot>,
): void {
    if (decision.publish) queryClient.setQueryData(queryKey, decision.publish);
    if (decision.reread) invalidate(queryClient, queryKey);
}

/**
 * Keeps cached snapshots of one channel current from its transient patch events. The snapshot is only ever written here
 * and by the read itself, so the cache and the live stream share one revision chain. The hold, replay, gap, and
 * overflow policy is `createRevisionConvergence` (shared with Mobile); this adapter maps it onto React Query: a query's
 * `fetchStatus` says whether a read is in flight, and its cache events say when the read settled or was dropped.
 *
 * A projection nobody has open has no cached query and is skipped without a read: patches for an unmounted Chat or a
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
    /**
     * The connection may have dropped patches: forget held ones. The caller invalidates the reads.
     */
    resync: () => void;
    dispose: () => void;
} {
    /**
     * One core per projection with held patches; released as soon as it holds nothing.
     */
    const cores = new Map<string, RevisionConvergence<TPatch, TSnapshot>>();
    const coreFor = (key: string): RevisionConvergence<TPatch, TSnapshot> => {
        let core = cores.get(key);
        if (!core) {
            core = createRevisionConvergence<TPatch, TSnapshot>({ apply: channel.apply });
            cores.set(key, core);
        }
        return core;
    };
    const release = (key: string): void => {
        const core = cores.get(key);
        if (core && !core.hasHeld()) cores.delete(key);
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        const queryKey = event.query.queryKey as readonly unknown[];
        const [method, parameters] = queryKey;
        if (!isQueryMethod([method], channel.method)) return;
        const key = channel.keyOfParameters(parameters);
        const core = cores.get(key);
        if (!core) return;
        // A read dropped while in flight (cache retention evicting it) settles nothing, so its held patches go with it.
        if (event.type === 'removed') {
            core.abandonRead();
            cores.delete(key);
            return;
        }
        if (event.type !== 'updated' || event.query.state.fetchStatus !== 'idle') return;
        if (event.query.state.status === 'success') {
            runDecision(
                queryClient,
                queryKey,
                core.settleRead(queryClient.getQueryData<TSnapshot>(queryKey)),
            );
        } else core.abandonRead();
        release(key);
    });
    return {
        apply: (patch) => {
            const key = channel.key(patch);
            const queryKey = channel.queryKey(patch);
            const state = queryClient.getQueryState(queryKey);
            if (!state) return;
            const core = coreFor(key);
            runDecision(
                queryClient,
                queryKey,
                core.receivePatch(
                    queryClient.getQueryData<TSnapshot>(queryKey),
                    patch,
                    state.fetchStatus === 'fetching',
                ),
            );
            release(key);
        },
        resync: () => {
            for (const core of cores.values()) core.reset();
            cores.clear();
        },
        dispose: () => {
            unsubscribe();
            // Cores hold only patches, no timers or subscriptions: dropping them is the whole teardown.
            cores.clear();
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
    const unsubscribeRetention = subscribeAgentChatCacheRetention(queryClient);
    const unsubscribe = caxri.onEvent((event) => {
        switch (event.event) {
            case 'agentChat.patch': {
                cache.apply(event.payload);
                if (isAgentChatWaitingPatch(event.payload)) invalidateAgentChatWaiting(queryClient);
                break;
            }
            case 'agentChat.taskPatch': {
                taskCache.apply(event.payload);
                break;
            }
            case 'host.connectionChanged': {
                cache.resync();
                taskCache.resync();
                invalidateAgentChatQueries(queryClient);
                invalidateAgentChatWaiting(queryClient);
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
        unsubscribeRetention();
        cache.dispose();
        taskCache.dispose();
    };
}
