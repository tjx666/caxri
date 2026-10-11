import { useCallback, useEffect, useState } from 'react';

import type { AgentChatRequest, AgentChatSnapshot, ParametersArgument } from '@caxri/protocol';

import { useMobileClient } from '../connection/mobile-client-provider';
import { startAgentChatReader } from './agent-chat-sync';

export type AgentChatResponse = NonNullable<
    ParametersArgument<'mobile.agentChat.respond'>[0]
>['response'];

/**
 * An uploaded image and its phone-made thumbnail, named by their upload ids; the Server reads both bytes.
 */
export interface AgentChatAttachment {
    attachmentId: string;
    thumbnailAttachmentId: string;
}

export interface AgentChatState {
    error: string | null;
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

    const refresh = useCallback((): void => {
        setRetry((value) => value + 1);
    }, []);

    const send = useCallback(
        async (text: string, attachments: readonly AgentChatAttachment[] = []): Promise<void> => {
            if (terminalId === null) return;
            await request('mobile.agentChat.send', {
                terminalId,
                text,
                ...(attachments.length > 0 && { attachments: [...attachments] }),
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
    const restart = useCallback(async (): Promise<void> => {
        if (terminalId === null) return;
        await request('mobile.agentChat.retry', { terminalId });
        setRetry((value) => value + 1);
    }, [request, terminalId]);

    return { ...state, interrupt, refresh, respond, restart, send };
};

export type AgentChatController = ReturnType<typeof useAgentChat>;
