import { useCallback, useRef, useState } from 'react';

import type { ThemeTokens } from '@caxri/protocol';
import type { ISearchOptions } from '@xterm/addon-search';
import { SearchAddon } from '@xterm/addon-search';

import { translate } from '../../../i18n';
import { runThenCleanup } from '../../../lib/await-then-cleanup';
import { emptySearchResults, opaqueSearchColor } from '../terminal-pane-support';
import type { TerminalSearchOptions, TerminalSearchResults } from '../terminal-search';
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
 * The user-facing reason a search failed. Kept outside the hook because React Compiler cannot lower a conditional
 * inside a try/catch.
 */
function searchFailureMessage(error: unknown): string {
    return translate(
        error instanceof SyntaxError
            ? 'terminal.search.invalidRegex'
            : 'terminal.search.unavailable',
    );
}

/**
 * Owns xterm search state and decoration lifecycle independently from the pane's PTY lifecycle.
 */
export function useTerminalPaneSearch(latest: TerminalThemeReference) {
    const searchReference = useRef<SearchAddon | undefined>(undefined);
    const [selectionGuard] = useState(createTerminalSearchSelectionGuard);
    const searchSignatureReference = useRef('');
    const [searchResults, setSearchResults] = useState<TerminalSearchResults>(emptySearchResults);

    const registerSearchAddon = useCallback(
        (search: SearchAddon): (() => void) => {
            searchReference.current = search;
            const resultsDisposable = search.onDidChangeResults(({ resultCount, resultIndex }) =>
                setSearchResults({ resultCount, resultIndex }),
            );
            /**
             * The addon re-runs its cached query by itself 200ms after every write and resize, so copy-on-select has to
             * learn about the selection from the addon's own search lifecycle. A guard wrapped around this pane's
             * navigation calls would miss those, and a Terminal that keeps printing would repeatedly overwrite the
             * clipboard with the active match while the search bar is open.
             */
            const beforeSearchDisposable = search.onBeforeSearch(() =>
                selectionGuard.beginSearchSelection(),
            );
            const afterSearchDisposable = search.onAfterSearch(() =>
                selectionGuard.endSearchSelection(),
            );
            return () => {
                resultsDisposable.dispose();
                beforeSearchDisposable.dispose();
                afterSearchDisposable.dispose();
                selectionGuard.endSearchSelection();
                if (searchReference.current !== search) return;
                searchReference.current = undefined;
                searchSignatureReference.current = '';
            };
        },
        [selectionGuard],
    );

    const endSearch = useCallback((): void => {
        runThenCleanup(
            () => searchReference.current?.clearDecorations(),
            () => {
                searchSignatureReference.current = '';
                setSearchResults(emptySearchResults);
            },
        );
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
            const signature = JSON.stringify([query, options, theme]);
            /**
             * Computed before the `try`: React Compiler cannot lower a conditional or logical expression inside a
             * try/catch.
             */
            const hasSignatureChanged =
                isIncremental && signature !== searchSignatureReference.current;
            try {
                /**
                 * Addon-search beta updates its cached options before checking whether options changed, so toggling
                 * Match Case/Whole Word/Regex for the same query would retain stale decorations and counts. Clear only
                 * on an incremental signature change; explicit next/previous navigation must preserve the result.
                 */
                if (hasSignatureChanged) search.clearDecorations();
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
                    error: searchFailureMessage(error),
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
