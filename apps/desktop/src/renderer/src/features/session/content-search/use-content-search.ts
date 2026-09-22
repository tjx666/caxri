import { useMemo, useState } from 'react';

import { useQuery } from '@tanstack/react-query';

import { useDebouncedValue } from '../../../hooks/use-debounced-value';
import { caxri } from '../../../lib/caxri';
import { useProjects, useSessions } from '../../../stores/selectors';
import { contentSearchItems } from './content-search-model';

const EMPTY: never[] = [];

/**
 * Query identity hides stale snippets immediately; consumed AbortSignal cancels abandoned Server work.
 */
export function useContentSearch() {
    const [query, setQuery] = useState('');
    const trimmed = query.trim();
    const debounced = useDebouncedValue(trimmed, 250);
    const isSettled = trimmed === debounced;
    const sessions = useSessions() ?? EMPTY;
    const projects = useProjects() ?? EMPTY;
    const response = useQuery({
        queryKey: ['session-content-search', debounced],
        queryFn: ({ signal }) =>
            caxri.requestWithSignal('session.searchContent', signal, { query: debounced }),
        enabled: debounced.length > 0 && isSettled,
        retry: false,
        gcTime: 0,
        staleTime: 0,
    });
    const result = isSettled && trimmed ? response.data : undefined;
    const items = useMemo(
        () => contentSearchItems(result, sessions, projects),
        [result, sessions, projects],
    );
    return {
        query,
        setQuery,
        result,
        items,
        isActive: trimmed.length > 0,
        isLoading: trimmed.length > 0 && (!isSettled || response.isFetching),
        isError: isSettled && response.isError,
        retry: () => {
            // eslint-disable-next-line no-void -- query state owns the retry result and error
            void response.refetch();
        },
    };
}
