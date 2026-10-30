import { useMemo, useState } from 'react';

import type { AgentProvider, SessionSearchStatusFilter } from '@caxri/protocol';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useDebouncedValue } from '../../../hooks/use-debounced-value';
import { caxri } from '../../../lib/caxri';
import { useDialogStore } from '../../../stores/dialogs';
import { selectSelectedProject } from '../../../stores/selectors';
import { useWorkbenchStore } from '../../../stores/workbench';
import type {
    SessionSearchFilterChip,
    SessionSearchScope,
    SessionSearchSort,
} from './session-search-model';
import {
    removeSessionSearchOperator,
    removeSessionSearchOperators,
    retainedSelectionIndex,
    sessionSearchFilterChips,
    sortSessionSearchEntries,
} from './session-search-model';

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
    /**
     * Read without subscribing: the seed only decides where this open starts, and the overlay remounts per open
     * request.
     */
    const [seed] = useState(() => useDialogStore.getState().sessionSearchRequest.seed);
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState<SessionSearchStatusFilter>(seed.status ?? 'all');
    const [provider, setProvider] = useState<AgentProvider>();
    const [sort, setSort] = useState<SessionSearchSort>('relevance');
    const [scope, setScope] = useState<SessionSearchScope>('currentProject');
    const [selectedKey, setSelectedKey] = useState<string>();
    const workbenchProjectId = useWorkbenchStore(
        (state) => selectSelectedProject(state.bootstrap)?.id,
    );
    /**
     * A Project-scoped opener (the New Session menu's import row) ranks its own Project first, which need not be the
     * selected one.
     */
    const selectedProjectId = seed.projectId ?? workbenchProjectId;
    /**
     * The Project the Server ranks first, or undefined when every Project ranks alike (the user chose All Projects, or
     * no Project is selected).
     */
    const currentProjectId = scope === 'currentProject' ? selectedProjectId : undefined;
    const debounced = useDebouncedValue(query.trim(), QUERY_DEBOUNCE_MS);
    const response = useQuery({
        queryKey: ['session-search', debounced, status, provider, currentProjectId],
        queryFn: ({ signal }) =>
            caxri.requestWithSignal('session.search', signal, {
                query: debounced,
                status,
                ...(provider && { providers: [provider] }),
                ...(currentProjectId && { currentProjectId }),
            }),
        placeholderData: keepPreviousData,
        refetchInterval: (current) =>
            current.state.data?.index.state === 'indexing' ? INDEXING_REFRESH_MS : false,
        retry: false,
        gcTime: 0,
        staleTime: 0,
    });
    const entries = useMemo(
        () => sortSessionSearchEntries(response.data?.entries ?? [], sort),
        [response.data, sort],
    );
    /**
     * The selection follows a conversation, not a row number: a refresh while history is still indexing re-ranks the
     * rows, and Enter must still act on the conversation the user picked. Only a new query or filter starts back at the
     * best match, once its own results (not the previous query's placeholder) arrive.
     */
    const selectionKey = response.isPlaceholderData
        ? undefined
        : JSON.stringify([debounced, status, provider, currentProjectId, sort]);
    const [selectionScope, setSelectionScope] = useState(selectionKey);
    if (selectionKey !== undefined && selectionKey !== selectionScope) {
        setSelectionScope(selectionKey);
        setSelectedKey(undefined);
    }
    const filterChips = useMemo(
        () => sessionSearchFilterChips(response.data?.filters),
        [response.data],
    );
    const selectedIndex = retainedSelectionIndex(entries, selectedKey);
    return {
        query,
        setQuery,
        /**
         * The query the listed results answer, which trails typing by the debounce.
         */
        searchedQuery: debounced,
        status,
        setStatus,
        provider,
        setProvider,
        sort,
        setSort,
        scope,
        setScope,
        /**
         * Whether a Project is selected, which is what the scope toggle needs to mean anything.
         */
        hasCurrentProject: selectedProjectId !== undefined,
        /**
         * Dismisses a parsed operator chip by deleting its operator from the query text.
         */
        removeFilterChip: (chip: SessionSearchFilterChip) =>
            setQuery((current) => removeSessionSearchOperator(current, chip)),
        /**
         * Parsed operator chips for the listed results; they count as active filters even when Where and Agent are
         * untouched.
         */
        filterChips,
        /**
         * Resets Where and Agent and deletes every parsed operator from the query.
         */
        clearFilters: () => {
            setStatus('all');
            setProvider(undefined);
            setQuery((current) => removeSessionSearchOperators(current, filterChips));
        },
        /**
         * Re-runs the failed search; the promise is not awaited because a failure lands in `isError` again.
         */
        refetch: () => response.refetch(),
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
