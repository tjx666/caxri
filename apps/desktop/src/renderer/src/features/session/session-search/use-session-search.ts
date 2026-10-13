import { useState } from 'react';

import type { AgentProvider, SessionSearchStatusFilter } from '@caxri/protocol';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useDebouncedValue } from '../../../hooks/use-debounced-value';
import { caxri } from '../../../lib/caxri';
import { retainedSelectionIndex } from './session-search-model';

/**
 * Debounce for typing. The index answers in milliseconds, so this only spares the Worker a query per keystroke.
 */
const QUERY_DEBOUNCE_MS = 120;
/**
 * While the background index is still reading changed history, the listing refreshes at this cadence so new matches
 * appear without another keystroke.
 */
const INDEXING_REFRESH_MS = 1_500;

/**
 * Query, filters, and results of the Session search overlay. The previous result stays on screen while the next one
 * loads, so typing never flashes an empty list; the consumed AbortSignal cancels a superseded search in the Worker.
 */
export function useSessionSearch() {
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState<SessionSearchStatusFilter>('all');
    const [provider, setProvider] = useState<AgentProvider>();
    const [selectedKey, setSelectedKey] = useState<string>();
    const debounced = useDebouncedValue(query.trim(), QUERY_DEBOUNCE_MS);
    const response = useQuery({
        queryKey: ['session-search', debounced, status, provider],
        queryFn: ({ signal }) =>
            caxri.requestWithSignal('session.search', signal, {
                query: debounced,
                status,
                ...(provider && { providers: [provider] }),
            }),
        placeholderData: keepPreviousData,
        refetchInterval: (current) =>
            current.state.data?.index.state === 'indexing' ? INDEXING_REFRESH_MS : false,
        retry: false,
        gcTime: 0,
        staleTime: 0,
    });
    const entries = response.data?.entries ?? [];
    /**
     * The selection follows a conversation, not a row number: a refresh while history is still indexing re-ranks the
     * rows, and Enter must still act on the conversation the user picked. Only a new query or filter starts back at the
     * best match, once its own results (not the previous query's placeholder) arrive.
     */
    const scope = response.isPlaceholderData
        ? undefined
        : JSON.stringify([debounced, status, provider]);
    const [selectionScope, setSelectionScope] = useState(scope);
    if (scope !== undefined && scope !== selectionScope) {
        setSelectionScope(scope);
        setSelectedKey(undefined);
    }
    const selectedIndex = retainedSelectionIndex(entries, selectedKey);
    return {
        query,
        setQuery,
        status,
        setStatus,
        provider,
        setProvider,
        result: response.data,
        entries,
        selectedIndex,
        selected: entries.at(selectedIndex),
        setSelectedIndex: (index: number) => setSelectedKey(entries.at(index)?.key),
        isLoading: response.data === undefined && !response.isError,
        isFetching: response.isFetching,
        isError: response.isError && response.data === undefined,
    };
}

export type SessionSearchModel = ReturnType<typeof useSessionSearch>;
