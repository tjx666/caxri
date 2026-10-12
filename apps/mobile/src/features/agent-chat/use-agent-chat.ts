import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type {
    AgentChatModelRequest,
    AgentChatPermissionRequest,
    AgentChatRequest,
    AgentChatResponse,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { agentChatPendingView } from '@caxri/protocol';

import { useMobileClient } from '../connection/mobile-client-provider';
import { useReadCache } from '../read-cache/read-cache-context';
import {
    cachedChatSchema,
    liveReadSaveScope,
    trimChatSnapshot,
} from '../read-cache/read-cache-model';
import {
    agentChatPendingKey,
    agentChatPendingStore,
    answerAgentChatRequestOptimistically,
} from './agent-chat-pending';
import { startAgentChatReader } from './agent-chat-sync';

/**
 * An uploaded image and its phone-made thumbnail, named by their upload ids; the Server reads both bytes.
 */
export interface AgentChatAttachment {
    attachmentId: string;
    thumbnailAttachmentId: string;
}

export interface AgentChatState {
    error: string | null;
    /**
     * The pairing the live snapshot was read under; only that pairing may save it.
     */
    readScope?: string;
    /**
     * Set while the snapshot is the copy saved on this phone; the first live snapshot replaces it.
     */
    savedAt?: number;
    snapshot: AgentChatSnapshot | undefined;
    /**
     * `stale` keeps the last copy on screen while the phone cannot observe the Chat.
     */
    status: 'loading' | 'ready' | 'error' | 'stale';
}

const NO_PENDING = agentChatPendingStore.get('');

/**
 * The Chat's sends and answers still ahead of its projection (`agent-chat-pending.ts`), pruned as the projection shows
 * them, so a pending row and the real one never appear together.
 */
const useAgentChatPending = (key: string | null, snapshot: AgentChatSnapshot | undefined) => {
    const subscribe = useCallback(
        (listener: () => void) =>
            key === null ? () => {} : agentChatPendingStore.subscribe(key, listener),
        [key],
    );
    const read = useCallback(
        () => (key === null ? NO_PENDING : agentChatPendingStore.get(key)),
        [key],
    );
    const state = useSyncExternalStore(subscribe, read, read);
    useEffect(() => {
        if (key !== null) agentChatPendingStore.prune(key, snapshot);
    }, [key, snapshot]);
    const view = useMemo(
        () => agentChatPendingView(state.messages, state.answers, snapshot),
        [snapshot, state.answers, state.messages],
    );
    return { ...view, sendCount: state.sendCount };
};

const initialState = (): AgentChatState => ({
    error: null,
    snapshot: undefined,
    status: 'loading',
});

/**
 * Observes one Chat while it is on screen and exposes the phone's actions on it. Every action resolves the Terminal on
 * the Server again, so a revoked grant or a Terminal that stopped being a Chat fails there, not here.
 */
export const useAgentChat = ({
    enabled,
    terminalId,
}: {
    enabled: boolean;
    terminalId: string | null;
}) => {
    const {
        connectionEpoch,
        connectionScopeKey,
        isForeground,
        request,
        status: connectionStatus,
        subscribe,
        subscriptionAvailable,
    } = useMobileClient();
    const [record, setRecord] = useState<{ terminalId: string | null; state: AgentChatState }>(
        () => ({ terminalId, state: initialState() }),
    );
    const [retry, setRetry] = useState(0);
    const readCache = useReadCache();
    const observable =
        enabled && terminalId !== null && isForeground && connectionStatus === 'connected';
    const stored = record.terminalId === terminalId ? record.state : initialState();
    const state: AgentChatState =
        !observable && stored.snapshot ? { ...stored, status: 'stale' } : stored;
    /**
     * Where this Chat's optimistic sends and answers live; see `agent-chat-pending.ts`.
     */
    const pendingKey =
        terminalId === null ? null : agentChatPendingKey(connectionScopeKey, terminalId);
    const pending = useAgentChatPending(pendingKey, stored.snapshot);

    useEffect(() => {
        if (terminalId === null || !observable || connectionScopeKey === null) return;
        let isActive = true;
        const readScope = connectionScopeKey;
        const update = (value: (current: AgentChatState) => AgentChatState): void => {
            if (!isActive) return;
            setRecord((current) => ({
                terminalId,
                state: value(current.terminalId === terminalId ? current.state : initialState()),
            }));
        };
        const stop = startAgentChatReader({
            read: () => request('mobile.agentChat.read', { terminalId }),
            subscribe: subscriptionAvailable
                ? (listener) => subscribe({ kind: 'agentChat', terminalId }, listener)
                : undefined,
            onRetry: () => setRetry((value) => value + 1),
            onSnapshot: (snapshot) =>
                update(() => ({ error: null, readScope, snapshot, status: 'ready' })),
            onError: () =>
                update((current) => ({
                    ...current,
                    error: 'Unable to load this Chat.',
                    status: current.snapshot ? 'stale' : 'error',
                })),
        });
        return () => {
            isActive = false;
            stop();
        };
    }, [
        connectionEpoch,
        connectionScopeKey,
        observable,
        request,
        retry,
        subscribe,
        subscriptionAvailable,
        terminalId,
    ]);

    useEffect(() => {
        if (terminalId === null || connectionScopeKey === null) return;
        let isActive = true;
        // eslint-disable-next-line no-void -- A missing or unreadable copy leaves the Chat loading as before.
        void readCache
            .load(connectionScopeKey, { kind: 'chat', terminalId }, cachedChatSchema)
            .then((entry) => {
                if (!isActive || !entry) return;
                setRecord((current) => {
                    const base = current.terminalId === terminalId ? current.state : initialState();
                    // Only fills a Chat nothing live has answered yet; a failed first read still shows it.
                    if (base.snapshot) return current;
                    return {
                        terminalId,
                        state: { ...base, savedAt: entry.savedAt, snapshot: entry.value },
                    };
                });
            });
        return () => {
            isActive = false;
        };
    }, [connectionScopeKey, readCache, terminalId]);

    const liveSnapshot = stored.savedAt === undefined ? stored.snapshot : undefined;
    const saveScope = liveReadSaveScope(stored.readScope, connectionScopeKey);
    useEffect(() => {
        if (!liveSnapshot || saveScope === null) return;
        readCache.save(
            saveScope,
            { kind: 'chat', terminalId: liveSnapshot.terminalId },
            trimChatSnapshot(liveSnapshot),
        );
    }, [liveSnapshot, readCache, saveScope]);

    const refresh = useCallback((): void => {
        setRetry((value) => value + 1);
    }, []);

    /**
     * Sends a message. While a turn runs it waits in the follow-up queue unless `delivery` is `steer`.
     */
    const send = useCallback(
        async (
            text: string,
            attachments: readonly AgentChatAttachment[] = [],
            delivery?: 'steer',
        ): Promise<void> => {
            if (terminalId === null) return;
            await request('mobile.agentChat.send', {
                terminalId,
                text,
                ...(attachments.length > 0 && { attachments: [...attachments] }),
                ...(delivery && { delivery }),
            });
        },
        [request, terminalId],
    );
    /**
     * Runs one of the provider's listed slash commands; during a turn Core queues it, since a command cannot join a
     * turn.
     */
    const runCommand = useCallback(
        async (command: { name: string; arguments?: string }): Promise<void> => {
            if (terminalId === null) return;
            await request('mobile.agentChat.runCommand', {
                terminalId,
                name: command.name,
                ...(command.arguments !== undefined && { arguments: command.arguments }),
            });
        },
        [request, terminalId],
    );
    const interrupt = useCallback(async (): Promise<void> => {
        if (terminalId === null) return;
        await request('mobile.agentChat.interrupt', { terminalId });
    }, [request, terminalId]);
    /**
     * Answers optimistically: the card leaves at once and comes back, rejecting, when the Server refuses.
     */
    const respond = useCallback(
        async (target: AgentChatRequest, response: AgentChatResponse): Promise<void> => {
            if (terminalId === null || pendingKey === null) return;
            await answerAgentChatRequestOptimistically({
                key: pendingKey,
                request: target,
                response,
                respond: async () => {
                    await request('mobile.agentChat.respond', {
                        terminalId,
                        requestId: target.id,
                        response,
                    });
                },
            });
        },
        [pendingKey, request, terminalId],
    );
    /**
     * Switches the model, effort, ultracode, permission level, or plan mode the next turn uses; Core validates the
     * change against what the provider offers, and the gateway refuses a permission change from a `reply` device.
     */
    const configure = useCallback(
        async (change: AgentChatModelRequest & AgentChatPermissionRequest): Promise<void> => {
            if (terminalId === null) return;
            await request('mobile.agentChat.configure', { terminalId, ...change });
        },
        [request, terminalId],
    );
    const restart = useCallback(async (): Promise<void> => {
        if (terminalId === null) return;
        await request('mobile.agentChat.retry', { terminalId });
        setRetry((value) => value + 1);
    }, [request, terminalId]);

    /**
     * The queue card's actions, forwarded to Server Core's queue like Desktop's. Core refuses a message that already
     * left the queue, and a command steering a running turn.
     */
    const removeQueued = useCallback(
        async (id: string): Promise<void> => {
            if (terminalId === null) return;
            await request('mobile.agentChat.removeQueued', { terminalId, id });
        },
        [request, terminalId],
    );
    const sendQueuedNow = useCallback(
        async (id: string): Promise<void> => {
            if (terminalId === null) return;
            await request('mobile.agentChat.sendQueuedNow', { terminalId, id });
        },
        [request, terminalId],
    );
    /**
     * Takes a queued message back for editing and resolves its full text; the snapshot holds only a preview.
     */
    const takeQueued = useCallback(
        async (id: string): Promise<string> => {
            if (terminalId === null) throw new Error('No Chat is open');
            const { text } = await request('mobile.agentChat.takeQueued', { terminalId, id });
            return text;
        },
        [request, terminalId],
    );
    const resumeQueue = useCallback(async (): Promise<void> => {
        if (terminalId === null) return;
        await request('mobile.agentChat.resumeQueue', { terminalId });
    }, [request, terminalId]);

    return {
        ...state,
        configure,
        interrupt,
        pending,
        pendingKey,
        refresh,
        removeQueued,
        respond,
        restart,
        resumeQueue,
        runCommand,
        send,
        sendQueuedNow,
        takeQueued,
    };
};

export type AgentChatController = ReturnType<typeof useAgentChat>;
