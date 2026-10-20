import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { AgentChatOlderHistory, AgentChatSnapshot } from '@caxri/protocol';
import {
    agentChatHistoryCursor,
    emptyAgentChatOlderHistory,
    prependAgentChatHistoryPage,
} from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { useMobileClient } from '../connection/mobile-client-provider';
import type { ConversationTimelineState } from '../conversation/use-conversation-timeline';
import {
    canLoadOlderAgentChatHistory,
    mergeAgentChatOlderHistory,
    syncAgentChatOlderHistory,
} from './agent-chat-older-history';

interface HistoryRecord {
    /**
     * The pairing and Chat the pages belong to; another one starts over.
     */
    scope: string;
    /**
     * The window the pages were last reconciled with, so the next one can tell what it evicted.
     */
    snapshot: AgentChatSnapshot | undefined;
    history: AgentChatOlderHistory;
}

/**
 * The phone's history above a Chat's window: pages read through `mobile.agentChat.readHistory` as the reader scrolls
 * back, held in memory only (never written to the read cache, which keeps just the window). Returns the merged snapshot
 * the timeline builds from and the `ConversationList` paging state, which mirrors the terminal Conversation's: a
 * load-earlier button and a load on reaching the top.
 */
export const useAgentChatHistory = (
    snapshot: AgentChatSnapshot | undefined,
    /**
     * Whether `snapshot` is a live read on a connected phone, not a saved copy; only then can a page be requested.
     */
    isLive: boolean,
) => {
    const { connectionScopeKey, request } = useMobileClient();
    const { t } = useTranslation();
    const scope = JSON.stringify([connectionScopeKey, snapshot?.terminalId ?? null]);
    const [record, setRecord] = useState<HistoryRecord>(() => ({
        scope,
        snapshot,
        history: emptyAgentChatOlderHistory(snapshot?.historyId),
    }));
    let current = record;
    /**
     * Reconciled while rendering, not in an effect, so an item that just left the window is kept in the same render and
     * never blinks out of the transcript.
     */
    if (record.scope !== scope) {
        current = { scope, snapshot, history: emptyAgentChatOlderHistory(snapshot?.historyId) };
        setRecord(current);
    } else if (record.snapshot !== snapshot) {
        current = {
            scope,
            snapshot,
            history: syncAgentChatOlderHistory(record.history, record.snapshot, snapshot),
        };
        setRecord(current);
    }
    const { history } = current;
    /**
     * The newest record for `loadOlder`, which stays one stable callback while the window streams.
     */
    const latest = useRef(current);
    useLayoutEffect(() => {
        latest.current = current;
    });
    const inFlight = useRef(false);

    const canLoad = isLive && canLoadOlderAgentChatHistory(history, snapshot);
    const olderCursor = canLoad ? agentChatHistoryCursor(history, snapshot) : undefined;

    const loadOlder = useCallback(async (): Promise<void> => {
        const base = latest.current;
        const terminalId = base.snapshot?.terminalId;
        const beforeItemId = agentChatHistoryCursor(base.history, base.snapshot);
        if (!terminalId || !beforeItemId || inFlight.current) return;
        if (!canLoadOlderAgentChatHistory(base.history, base.snapshot)) return;
        inFlight.current = true;
        const { historyId } = base.history;
        const update = (next: (value: AgentChatOlderHistory) => AgentChatOlderHistory) =>
            setRecord((value) =>
                value.scope === base.scope && value.history.historyId === historyId
                    ? { ...value, history: next(value.history) }
                    : value,
            );
        update((value) => ({ ...value, status: 'loading' }));
        try {
            const page = await request('mobile.agentChat.readHistory', {
                terminalId,
                beforeItemId,
            });
            // A page for a replaced conversation is dropped by `prependAgentChatHistoryPage` itself.
            update((value) => ({
                ...prependAgentChatHistoryPage(value, page, latest.current.snapshot?.items ?? []),
                status: 'idle',
            }));
        } catch {
            update((value) => ({ ...value, status: 'failed' }));
        } finally {
            inFlight.current = false;
        }
    }, [request]);

    const merged = useMemo(
        () => (snapshot ? mergeAgentChatOlderHistory(snapshot, history) : undefined),
        [history, snapshot],
    );
    const isLoadingOlder = isLive && history.status === 'loading';
    const error = history.status === 'failed' ? t('chat.history.loadFailed') : null;
    /**
     * The list's history header: a load-earlier button while more can load, and the "on your computer" note only once
     * nothing more can load and the conversation is still cut.
     */
    const needsConnectionForOlder =
        !isLive && snapshot !== undefined && canLoadOlderAgentChatHistory(history, snapshot);
    const truncated = !canLoad && !needsConnectionForOlder && (merged?.truncated ?? false);
    const timeline = useMemo<ConversationTimelineState & { loadOlder: () => Promise<void> }>(
        () => ({
            error,
            historyExpired: false,
            isLoadingOlder,
            items: [],
            loadOlder,
            needsConnectionForOlder,
            ...(olderCursor !== undefined && { olderCursor }),
            status: 'available',
            truncated,
        }),
        [error, isLoadingOlder, loadOlder, needsConnectionForOlder, olderCursor, truncated],
    );
    return { snapshot: merged, timeline };
};
