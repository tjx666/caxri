import { useMemo, useState } from 'react';

import type { SessionSearchEntry } from '@caxri/protocol';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useDebouncedValue } from '../../../hooks/use-debounced-value';
import { caxri } from '../../../lib/caxri';
import { steppedMatchIndex } from './session-search-model';

/**
 * Selection must settle this long before the preview is requested, so holding an arrow key through the list sends one
 * read for the row it stops on instead of one per row.
 */
const PREVIEW_DEBOUNCE_MS = 80;

/**
 * The preview of the selected result: a bounded window of its indexed messages around one match of the searched query,
 * with the match stepping the dialog's keyboard and buttons drive. Read-only on the Server, so previewing a
 * conversation that is not in Caxri never creates a Session.
 */
export function useSessionSearchPreview(selected: SessionSearchEntry | undefined, query: string) {
    const provider = selected?.provider;
    const agentSessionId = selected?.agentSessionId;
    const target = useMemo(
        () => (provider && agentSessionId ? { provider, agentSessionId } : undefined),
        [provider, agentSessionId],
    );
    const debouncedTarget = useDebouncedValue(target, PREVIEW_DEBOUNCE_MS);
    /**
     * The chosen match belongs to one conversation and query; a new selection or query starts back at the first match.
     */
    const scope = JSON.stringify([debouncedTarget, query]);
    const [chosen, setChosen] = useState({ scope, index: 0 });
    const requestedIndex = chosen.scope === scope ? chosen.index : 0;
    const response = useQuery({
        queryKey: ['session-search-preview', debouncedTarget, query, requestedIndex],
        queryFn: ({ signal }) =>
            caxri.requestWithSignal('session.searchPreview', signal, {
                ...debouncedTarget!,
                query,
                matchIndex: requestedIndex,
            }),
        enabled: debouncedTarget !== undefined,
        placeholderData: keepPreviousData,
        retry: false,
        gcTime: 10_000,
    });
    const matchCount = response.data?.matchCount ?? 0;
    const stepMatch = (delta: number): void => {
        if (matchCount < 2) return;
        setChosen({
            scope,
            index: steppedMatchIndex(matchCount, response.data?.matchIndex ?? 0, delta),
        });
    };
    return {
        /**
         * Whether the selected result has an Agent conversation to read; a Shell-only Session has none.
         */
        hasConversation: target !== undefined,
        data: response.data,
        /**
         * The window shown is the previous selection's, while the new one loads.
         */
        isStale: response.isPlaceholderData,
        isLoading:
            response.data === undefined && !response.isError && debouncedTarget !== undefined,
        isError: response.isError && response.data === undefined,
        stepMatch,
    };
}

export type SessionSearchPreviewModel = ReturnType<typeof useSessionSearchPreview>;
