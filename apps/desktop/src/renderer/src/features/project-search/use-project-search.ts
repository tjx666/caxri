import type { Dispatch, SetStateAction } from 'react';
import { useMemo, useState } from 'react';

import type { FileSearchMatch, FileSearchMode } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';

import { useDebouncedValue } from '@/hooks/use-debounced-value';

import { caxri } from '../../lib/caxri';
import { useSelectedSession } from '../../stores/selectors';
import { projectSearchQueryKey } from './project-search-query';
import { searchMatchKey, selectableSearchMatches } from './project-search-selection';
import type { ProjectSearchDisplayState } from './project-search-status';
import {
    projectSearchDisplayState,
    projectSearchTerminationMessage,
} from './project-search-status';
import type { NameSearchNode } from './project-search-tree';
import { buildNameSearchTree, groupSearchMatches } from './project-search-tree';

const NO_MATCHES: FileSearchMatch[] = [];

/**
 * The query the user is composing, together with everything derived from the Server's answer to it.
 *
 * Kept apart from the overlay's markup because the two change for unrelated reasons: this half is the search itself:
 * options, debouncing, cancellation, and which row the keyboard is on; while the markup is a controls bar, a result
 * list, and a preview pane that only read it.
 */
export interface ProjectSearchModel {
    displayState: ProjectSearchDisplayState;
    exclude: string;
    groups: ReadonlyMap<string, FileSearchMatch[]>;
    include: string;
    isCaseSensitive: boolean;
    /**
     * A query has been typed, even if the Server has not answered it yet.
     */
    isActive: boolean;
    isFetching: boolean;
    /**
     * Whether the debounce has caught up with the typed query.
     */
    isSettled: boolean;
    isRegex: boolean;
    isTruncated: boolean;
    /**
     * Whether `.gitignore` and friends narrow the scan. Exposed as an explicit control because a search that silently
     * skipped a file is indistinguishable from one that found nothing.
     */
    isUsingIgnoreFiles: boolean;
    isWholeWord: boolean;
    mode: FileSearchMode;
    nameTree: readonly NameSearchNode[];
    query: string;
    /**
     * Every row Up/Down can land on, in painted order.
     */
    selectable: readonly FileSearchMatch[];
    selected: FileSearchMatch | undefined;
    selectedIndex: number;
    selectedKey: string | undefined;
    sessionId: string | undefined;
    setCaseSensitive: Dispatch<SetStateAction<boolean>>;
    setExclude: Dispatch<SetStateAction<string>>;
    setInclude: Dispatch<SetStateAction<string>>;
    setMode: Dispatch<SetStateAction<FileSearchMode>>;
    setQuery: Dispatch<SetStateAction<string>>;
    setRegex: Dispatch<SetStateAction<boolean>>;
    setSelectedIndex: (index: number) => void;
    setUseIgnoreFiles: Dispatch<SetStateAction<boolean>>;
    setWholeWord: Dispatch<SetStateAction<boolean>>;
    terminationMessage: string | undefined;
}

/**
 * Lives outside the Portal so closing a search cancels its work without discarding the user's query and filters.
 */
export function useProjectSearchDraft() {
    const [query, setQuery] = useState('');
    /**
     * Content, not name. `cmd+shift+f` means "search in files" in every editor this dialog is modelled on, and the
     * Project-wide name lookup it used to open is the one thing `cmd+p`'s path browser already does, including the same
     * bounded `files.search` in `name` mode. Opening on the mode the other shortcut owns spent the dialog's whole first
     * impression on a duplicate.
     */
    const [mode, setMode] = useState<FileSearchMode>('content');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [regex, setRegex] = useState(false);
    const [include, setInclude] = useState('');
    const [exclude, setExclude] = useState('');
    const [useIgnoreFiles, setUseIgnoreFiles] = useState(true);
    return {
        query,
        setQuery,
        mode,
        setMode,
        caseSensitive,
        setCaseSensitive,
        wholeWord,
        setWholeWord,
        regex,
        setRegex,
        include,
        setInclude,
        exclude,
        setExclude,
        useIgnoreFiles,
        setUseIgnoreFiles,
    };
}

export type ProjectSearchDraft = ReturnType<typeof useProjectSearchDraft>;

export function useProjectSearch(draft: ProjectSearchDraft): ProjectSearchModel {
    const session = useSelectedSession();
    const {
        query,
        setQuery,
        mode,
        setMode,
        caseSensitive,
        setCaseSensitive,
        wholeWord,
        setWholeWord,
        regex,
        setRegex,
        include,
        setInclude,
        exclude,
        setExclude,
        useIgnoreFiles,
        setUseIgnoreFiles,
    } = draft;
    /**
     * The selection is stored beside the result list it indexes into, so a new list resets to its first row during
     * render instead of through an effect that would paint a stale selection for one frame. The user is typing: the row
     * that was selected a keystroke ago usually no longer matches, and holding it would leave the preview showing a
     * file the query no longer finds.
     */
    const [selection, setSelection] = useState<{
        index: number;
        matches: readonly FileSearchMatch[];
    }>({ index: 0, matches: NO_MATCHES });
    const debouncedQuery = useDebouncedValue(query, 150);
    const isActive = query.length > 0;
    const isSettled = query === debouncedQuery;
    const sessionId = session?.id;
    const scopeId = session ? `${session.id}:${session.workbenchProjectId}` : '';
    const searchOptions = useMemo(
        () => ({
            mode,
            query: debouncedQuery || ' ',
            caseSensitive: mode === 'content' && caseSensitive,
            wholeWord: mode === 'content' && wholeWord,
            regex: mode === 'content' && regex,
            include,
            exclude,
            useIgnoreFiles,
        }),
        [caseSensitive, debouncedQuery, exclude, include, mode, regex, useIgnoreFiles, wholeWord],
    );
    /**
     * `useQuery` rather than `useCaxriQuery`, because only the raw hook hands `queryFn` the AbortSignal React Query
     * cancels when the key changes. A Project-wide content search is the one read in this app expensive enough that an
     * abandoned one has to stop Server work rather than merely be ignored on arrival: each keystroke abandons one.
     */
    const result = useQuery({
        queryKey: projectSearchQueryKey(scopeId, searchOptions),
        queryFn: ({ signal }) =>
            caxri.requestWithSignal('files.search', signal, {
                sessionId: sessionId!,
                consumer: 'project-search',
                ...searchOptions,
            }),
        enabled: sessionId !== undefined && debouncedQuery.length > 0,
    });
    const matches = result.data?.matches ?? NO_MATCHES;
    const groups = useMemo(() => groupSearchMatches(matches), [matches]);
    const nameTree = useMemo(() => buildNameSearchTree(matches), [matches]);
    const selectable = useMemo(
        () => selectableSearchMatches(mode, groups, nameTree),
        [groups, mode, nameTree],
    );
    const selectedIndex = selection.matches === matches ? selection.index : 0;
    /*
     * `at` rather than an index, because `selectable` is empty before the first search and whenever a query has no hits;
     * `at` types that away as `undefined` instead of lying about it, and on an empty list the clamp lands on -1, which
     * `at` also answers with `undefined`.
     */
    const selected = selectable.at(Math.min(selectedIndex, selectable.length - 1));
    const selectedKey = selected ? searchMatchKey(selected) : undefined;

    return {
        displayState: projectSearchDisplayState({
            active: isActive,
            settled: isSettled,
            fetching: result.isFetching,
            failed: result.isError,
            matchCount: result.data?.matches.length,
            truncated: result.data?.truncated,
            canceled: result.data?.canceled,
        }),
        exclude,
        groups,
        include,
        isActive,
        isCaseSensitive: caseSensitive,
        isFetching: result.isFetching,
        isRegex: regex,
        isSettled,
        isTruncated: result.data?.truncated === true,
        isUsingIgnoreFiles: useIgnoreFiles,
        isWholeWord: wholeWord,
        mode,
        nameTree,
        query,
        selectable,
        selected,
        selectedIndex,
        selectedKey,
        sessionId,
        setCaseSensitive,
        setExclude,
        setInclude,
        setMode,
        setQuery,
        setRegex,
        setSelectedIndex: (index: number) => setSelection({ index, matches }),
        setUseIgnoreFiles,
        setWholeWord,
        terminationMessage: result.data
            ? projectSearchTerminationMessage(
                  result.data.terminationReason,
                  result.data.scannedFiles,
                  result.data.matches.length > 0,
              )
            : undefined,
    };
}
