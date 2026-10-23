import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentTimelineItem, MobileTimelineReadResult } from '@caxri/protocol';

import { translate } from '../../i18n';
import { useMobileClient } from '../connection/mobile-client-provider';
import { useReadCache } from '../read-cache/read-cache-context';
import {
    cachedTimelineSchema,
    liveReadSaveScope,
    READ_CACHE_MAX_ITEMS,
    trimTimelineItems,
} from '../read-cache/read-cache-model';
import {
    applyLatestConversationPage,
    applyOlderConversationPage,
    CONVERSATION_BLUR_GRACE_MS,
    isConversationObservableThroughBlur,
    visibleConversationStatus,
} from './conversation-model';
import { startConversationReader } from './conversation-observation';

export interface ConversationTimelineState {
    error: string | null;
    historyExpired: boolean;
    isLoadingOlder: boolean;
    items: AgentTimelineItem[];
    /**
     * Older messages exist on the computer but cannot be requested until the phone reconnects.
     */
    needsConnectionForOlder?: boolean;
    olderCursor?: string;
    /**
     * The pairing the live items were read under; only that pairing may save them.
     */
    readScope?: string;
    /**
     * Set while the items are the copy saved on this phone; the first live read replaces them.
     */
    savedAt?: number;
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
        connectionScopeKey,
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
    const readCache = useReadCache();
    const olderInFlight = useRef(false);
    const olderRequestId = useRef(0);
    const storedState = record.sessionId === sessionId ? record.state : initialState();
    const observable =
        enabled && sessionId !== null && isForeground && connectionStatus === 'connected';
    const [isStaleAfterBlur, setIsStaleAfterBlur] = useState(false);
    /**
     * Both branches go through a timer, including the immediate `0`ms reset on regaining observability, so neither
     * commits state synchronously in the effect body (matches the `setTimeout(tick, 0)` used for the same reason in
     * `sessions-screen.tsx`). Regardless of the previous value, an unmount or a re-run from a new `observable` value
     * clears whichever timer is still pending.
     */
    useEffect(() => {
        const timer = setTimeout(
            () => setIsStaleAfterBlur(!observable),
            observable ? 0 : CONVERSATION_BLUR_GRACE_MS,
        );
        return () => clearTimeout(timer);
    }, [observable]);
    const isVisiblyObservable = isConversationObservableThroughBlur(observable, isStaleAfterBlur);
    const state = {
        ...storedState,
        status: visibleConversationStatus(storedState.status, isVisiblyObservable),
        isLoadingOlder: observable && storedState.isLoadingOlder,
    };

    useEffect(() => {
        if (sessionId === null || !observable || connectionScopeKey === null) return;
        let isActive = true;
        const readScope = connectionScopeKey;
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
                    // A saved copy has no cursor into the live history, so the live page replaces it.
                    ...applyLatestConversationPage(
                        current.savedAt === undefined ? current : initialState(),
                        result,
                    ),
                    error: null,
                    readScope,
                    status: result.status,
                })),
            onError: () =>
                update((current) => ({
                    ...current,
                    error: translate('conversation.loadFailed'),
                    status: current.items.length > 0 ? 'stale' : 'error',
                })),
        });
        return () => {
            isActive = false;
            olderRequestId.current += 1;
            olderInFlight.current = false;
            stop();
        };
    }, [
        connectionEpoch,
        connectionScopeKey,
        observable,
        request,
        retry,
        sessionId,
        subscribe,
        subscriptionAvailable,
    ]);

    useEffect(() => {
        if (sessionId === null || connectionScopeKey === null) return;
        let isActive = true;
        void readCache
            .load(connectionScopeKey, { kind: 'timeline', sessionId }, cachedTimelineSchema)
            .then((entry) => {
                if (!isActive || !entry) return;
                setRecord((current) => {
                    const base = current.sessionId === sessionId ? current.state : initialState();
                    // Only fills a Conversation nothing live has answered yet; a failed first read still shows it.
                    if (base.status !== 'loading' && base.status !== 'error') return current;
                    return {
                        sessionId,
                        state: {
                            ...base,
                            items: entry.value.items,
                            savedAt: entry.savedAt,
                            status: 'available',
                            truncated: entry.value.truncated,
                        },
                    };
                });
            });
        return () => {
            isActive = false;
        };
    }, [connectionScopeKey, readCache, sessionId]);

    const liveItems =
        storedState.status === 'available' && storedState.savedAt === undefined
            ? storedState.items
            : null;
    const saveScope = liveReadSaveScope(storedState.readScope, connectionScopeKey);
    useEffect(() => {
        if (liveItems === null || sessionId === null || saveScope === null) return;
        readCache.save(
            saveScope,
            { kind: 'timeline', sessionId },
            {
                items: trimTimelineItems(liveItems),
                truncated: storedState.truncated || liveItems.length > READ_CACHE_MAX_ITEMS,
            },
        );
    }, [liveItems, readCache, saveScope, sessionId, storedState.truncated]);

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
                        ? { ...current.state, error: translate('conversation.loadEarlierFailed') }
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
