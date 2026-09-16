import { useCallback, useRef, useState } from 'react';

import type { ThemeTokens } from '@caxri/protocol';
import type { ISearchOptions } from '@xterm/addon-search';
import { SearchAddon } from '@xterm/addon-search';

import { emptySearchResults, opaqueSearchColor } from '../terminal-pane-support';
import type {
    TerminalSearchOptions,
    TerminalSearchResults,
    TerminalSearchSelectionGuard,
} from '../terminal-search';
import {
    createTerminalSearchSelectionGuard,
    TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
} from '../terminal-search';

interface TerminalThemeReference {
    readonly current: {
        terminalTheme: ThemeTokens['terminal'] | undefined;
    };
}

/**
 * Owns xterm search state and decoration lifecycle independently from the pane's PTY lifecycle.
 */
export function useTerminalPaneSearch(latest: TerminalThemeReference) {
    const searchReference = useRef<SearchAddon | undefined>(undefined);
    const selectionGuardReference = useRef<TerminalSearchSelectionGuard | undefined>(undefined);
    selectionGuardReference.current ??= createTerminalSearchSelectionGuard();
    const selectionGuard = selectionGuardReference.current;
    const searchSignatureReference = useRef('');
    const [searchResults, setSearchResults] = useState<TerminalSearchResults>(emptySearchResults);

    const registerSearchAddon = useCallback(
        (search: SearchAddon): (() => void) => {
            searchReference.current = search;
            const resultsDisposable = search.onDidChangeResults(({ resultCount, resultIndex }) =>
                setSearchResults({ resultCount, resultIndex }),
            );
            const unwatchSelection = selectionGuard.watch(search);
            return () => {
                resultsDisposable.dispose();
                unwatchSelection();
                if (searchReference.current !== search) return;
                searchReference.current = undefined;
                searchSignatureReference.current = '';
            };
        },
        [selectionGuard],
    );

    const endSearch = useCallback((): void => {
        try {
            searchReference.current?.clearDecorations();
        } finally {
            searchSignatureReference.current = '';
            setSearchResults(emptySearchResults);
        }
    }, []);

    const find = useCallback(
        (
            direction: 'next' | 'previous',
            query: string,
            options: TerminalSearchOptions,
            isIncremental = false,
        ): void => {
            const search = searchReference.current;
            if (!search) return;
            const theme = latest.current.terminalTheme;
            const searchOptions: ISearchOptions = {
                ...options,
                incremental: isIncremental,
                ...(theme && {
                    decorations: {
                        activeMatchBackground: opaqueSearchColor(theme.yellow),
                        activeMatchBorder: opaqueSearchColor(theme.foreground),
                        activeMatchColorOverviewRuler: opaqueSearchColor(theme.yellow),
                        matchBackground: opaqueSearchColor(theme.selectionBackground),
                        matchBorder: opaqueSearchColor(theme.brightBlack),
                        matchOverviewRuler: opaqueSearchColor(theme.selectionBackground),
                    },
                }),
            };
            try {
                const signature = JSON.stringify([query, options, theme]);
                /**
                 * Addon-search beta updates its cached options before checking whether options changed, so toggling
                 * Match Case/Whole Word/Regex for the same query would retain stale decorations and counts. Clear only
                 * on an incremental signature change; explicit next/previous navigation must preserve the result.
                 */
                if (isIncremental && signature !== searchSignatureReference.current)
                    search.clearDecorations();
                searchSignatureReference.current = signature;
                if (!query) {
                    search.findNext('', searchOptions);
                    setSearchResults(emptySearchResults);
                    return;
                }
                if (direction === 'previous') search.findPrevious(query, searchOptions);
                else search.findNext(query, searchOptions);
            } catch (error) {
                search.clearDecorations();
                setSearchResults({
                    error:
                        error instanceof SyntaxError
                            ? 'Invalid regular expression'
                            : 'Search unavailable',
                    resultCount: 0,
                    resultIndex: -1,
                });
            }
        },
        [latest],
    );

    return {
        createSearchAddon: () =>
            new SearchAddon({ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT + 1 }),
        endSearch,
        find,
        isSearchSelection: () => selectionGuard.isSearchSelection(),
        registerSearchAddon,
        searchResults,
    };
}
