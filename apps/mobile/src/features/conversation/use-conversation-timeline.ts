import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentTimelineItem, MobileTimelineReadResult } from '@caxri/protocol';

import { useMobileClient } from '../connection/mobile-client-provider';
import {
    applyLatestConversationPage,
    applyOlderConversationPage,
    visibleConversationStatus,
} from './conversation-model';
import { startConversationReader } from './conversation-observation';

export interface ConversationTimelineState {
    error: string | null;
    historyExpired: boolean;
    isLoadingOlder: boolean;
    items: AgentTimelineItem[];
    olderCursor?: string;
    status: 'loading' | 'available' | 'unsupported' | 'missing' | 'error' | 'stale';
    truncated: boolean;
}

const initialState = (): ConversationTimelineState => ({
    error: null,
    historyExpired: false,
    isLoadingOlder: false,
    items: [],
    status: 'loading',
    truncated: false,
});

export const useConversationTimeline = ({
    enabled,
    sessionId,
}: {
    enabled: boolean;
    sessionId: string | null;
}) => {
    const {
        connectionEpoch,
        isForeground,
        request,
        retryConnection,
        status: connectionStatus,
        subscribe,
        subscriptionAvailable,
    } = useMobileClient();
    const [record, setRecord] = useState<{
        sessionId: string | null;
        state: ConversationTimelineState;
    }>(() => ({ sessionId, state: initialState() }));
    const [retry, setRetry] = useState(0);
    const olderInFlight = useRef(false);
    const olderRequestId = useRef(0);
    const storedState = record.sessionId === sessionId ? record.state : initialState();
    const observable =
        enabled && sessionId !== null && isForeground && connectionStatus === 'connected';
    const state = {
        ...storedState,
        status: visibleConversationStatus(storedState.status, observable),
        isLoadingOlder: observable && storedState.isLoadingOlder,
    };

    useEffect(() => {
        if (sessionId === null || !observable) return;
        let isActive = true;
        const update = (
            value: (current: ConversationTimelineState) => ConversationTimelineState,
        ) => {
            if (!isActive) return;
            setRecord((current) => ({
                sessionId,
                state: value(current.sessionId === sessionId ? current.state : initialState()),
            }));
        };
        const stop = startConversationReader<MobileTimelineReadResult>({
            read: () => request('mobile.timeline.read', { sessionId }),
            subscribe: subscriptionAvailable
                ? (listener) => subscribe({ kind: 'conversation', sessionId }, listener)
                : undefined,
            onRetry: () => setRetry((value) => value + 1),
            onResult: (result) =>
                update((current) => ({
                    ...applyLatestConversationPage(current, result),
                    error: null,
                    status: result.status,
                })),
            onError: () =>
                update((current) => ({
                    ...current,
                    error: 'Unable to load Conversation.',
                    status: current.items.length > 0 ? 'stale' : 'error',
                })),
        });
        return () => {
            isActive = false;
            olderRequestId.current += 1;
            olderInFlight.current = false;
            stop();
        };
    }, [connectionEpoch, observable, request, retry, sessionId, subscribe, subscriptionAvailable]);

    const loadOlder = useCallback(async (): Promise<void> => {
        if (!observable || !state.olderCursor || olderInFlight.current) return;
        olderInFlight.current = true;
        const requestId = ++olderRequestId.current;
        const before = state.olderCursor;
        setRecord((current) => ({
            ...current,
            state: { ...current.state, isLoadingOlder: true },
        }));
        try {
            const page: MobileTimelineReadResult = await request('mobile.timeline.read', {
                sessionId,
                before,
            });
            if (requestId !== olderRequestId.current) return;
            setRecord((current) => {
                if (current.sessionId !== sessionId) return current;
                return {
                    sessionId,
                    state: {
                        ...applyOlderConversationPage(current.state, page, before),
                        error: null,
                    },
                };
            });
        } catch {
            if (requestId !== olderRequestId.current) return;
            setRecord((current) => ({
                ...current,
                state:
                    current.sessionId === sessionId && current.state.olderCursor === before
                        ? { ...current.state, error: 'Unable to load earlier messages.' }
                        : current.state,
            }));
        } finally {
            if (requestId === olderRequestId.current) {
                olderInFlight.current = false;
                setRecord((current) => ({
                    ...current,
                    state:
                        current.sessionId === sessionId
                            ? { ...current.state, isLoadingOlder: false }
                            : current.state,
                }));
            }
        }
    }, [observable, request, sessionId, state.olderCursor]);

    const refresh = useCallback((): void => {
        if (connectionStatus === 'connected') setRetry((value) => value + 1);
        else retryConnection();
    }, [connectionStatus, retryConnection]);
    return { ...state, loadOlder, refresh };
};
