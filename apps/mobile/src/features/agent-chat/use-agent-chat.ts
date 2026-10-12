import { useCallback, useEffect, useState } from 'react';

import type { AgentChatRequest, AgentChatResponse, AgentChatSnapshot } from '@caxri/protocol';

import { useMobileClient } from '../connection/mobile-client-provider';
import { useReadCache } from '../read-cache/read-cache-context';
import { cachedChatSchema, trimChatSnapshot } from '../read-cache/read-cache-model';
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
     * Set while the snapshot is the copy saved on this phone; the first live snapshot replaces it.
     */
    savedAt?: number;
    snapshot: AgentChatSnapshot | undefined;
    /**
     * `stale` keeps the last copy on screen while the phone cannot observe the Chat.
     */
    status: 'loading' | 'ready' | 'error' | 'stale';
}

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

    useEffect(() => {
        if (terminalId === null || !observable) return;
        let isActive = true;
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
            onSnapshot: (snapshot) => update(() => ({ error: null, snapshot, status: 'ready' })),
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
    }, [connectionEpoch, observable, request, retry, subscribe, subscriptionAvailable, terminalId]);

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
    useEffect(() => {
        if (!liveSnapshot || connectionScopeKey === null) return;
        readCache.save(
            connectionScopeKey,
            { kind: 'chat', terminalId: liveSnapshot.terminalId },
            trimChatSnapshot(liveSnapshot),
        );
    }, [connectionScopeKey, liveSnapshot, readCache]);

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
    const interrupt = useCallback(async (): Promise<void> => {
        if (terminalId === null) return;
        await request('mobile.agentChat.interrupt', { terminalId });
    }, [request, terminalId]);
    const respond = useCallback(
        async (target: AgentChatRequest, response: AgentChatResponse): Promise<void> => {
            if (terminalId === null) return;
            await request('mobile.agentChat.respond', {
                terminalId,
                requestId: target.id,
                response,
            });
        },
        [request, terminalId],
    );
    const configure = useCallback(
        async (change: { model?: string; effort?: string }): Promise<void> => {
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

    return { ...state, configure, interrupt, refresh, respond, restart, send };
};

export type AgentChatController = ReturnType<typeof useAgentChat>;
