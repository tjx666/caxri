import { useEffect, useState } from 'react';

import type { MobileSessionSearchStatus } from '@caxri/protocol';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../../connection/mobile-client-provider';
import {
    SESSION_SEARCH_DEBOUNCE_MS,
    SESSION_SEARCH_INDEXING_REFRESH_MS,
} from '../session-search-model';

/**
 * Query, filter, and results of the Session search screen. The previous result stays on screen while the next one
 * loads, so typing never flashes an empty list.
 */
export const useSessionSearch = (currentProjectId: string | null) => {
    const { connectionScopeKey, isForeground, request, status: connection } = useMobileClient();
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState<MobileSessionSearchStatus>('caxri');
    const [searchedQuery, setSearchedQuery] = useState('');
    useEffect(() => {
        const timer = setTimeout(() => setSearchedQuery(query.trim()), SESSION_SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query]);
    const response = useQuery({
        enabled: connectionScopeKey !== null && isForeground && connection === 'connected',
        gcTime: 0,
        networkMode: 'always',
        placeholderData: keepPreviousData,
        queryFn: () =>
            request('mobile.session.search', {
                query: searchedQuery,
                status,
                ...(currentProjectId && { currentProjectId }),
            }),
        queryKey: [
            'mobile',
            'session-search',
            connectionScopeKey ?? 'unpaired',
            searchedQuery,
            status,
            currentProjectId,
        ],
        refetchInterval: (current) =>
            current.state.data?.index.state === 'indexing'
                ? SESSION_SEARCH_INDEXING_REFRESH_MS
                : false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
    });
    return { query, response, searchedQuery, setQuery, setStatus, status };
};
