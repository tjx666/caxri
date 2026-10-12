import type { Translate } from '../../i18n';

export const TERMINAL_SEARCH_HIGHLIGHT_LIMIT = 1_000;

export interface TerminalSearchOptions {
    caseSensitive: boolean;
    regex: boolean;
    wholeWord: boolean;
}

export interface TerminalSearchResults {
    error?: string;
    resultCount: number;
    resultIndex: number;
}

export interface TerminalSearchState extends TerminalSearchOptions {
    focusRevision: number;
    open: boolean;
    query: string;
}

export type TerminalSearchAction =
    | { type: 'open' }
    | { type: 'close' }
    | { type: 'reset' }
    | { type: 'query'; query: string }
    | { type: 'toggle'; option: keyof TerminalSearchOptions };

export const initialTerminalSearchState: TerminalSearchState = {
    caseSensitive: false,
    focusRevision: 0,
    open: false,
    query: '',
    regex: false,
    wholeWord: false,
};

export function terminalSearchReducer(
    state: TerminalSearchState,
    action: TerminalSearchAction,
): TerminalSearchState {
    if (action.type === 'open')
        return { ...state, focusRevision: state.focusRevision + 1, open: true };
    if (action.type === 'close') return { ...state, open: false };
    if (action.type === 'reset') return initialTerminalSearchState;
    if (action.type === 'query') return { ...state, query: action.query };
    return { ...state, [action.option]: !state[action.option] };
}

export interface TerminalSearchSelectionGuard {
    /**
     * Raised from the addon's `onBeforeSearch`, released from its `onAfterSearch`.
     */
    beginSearchSelection(): void;
    endSearchSelection(): void;
    /**
     * True only while the search addon is applying its own match selection.
     */
    isSearchSelection(): boolean;
}

/**
 * Marks the selection changes the search addon itself produces, so copy-on-select can skip exactly those instead of
 * turning itself off for as long as the search bar stays open: a mouse selection made while searching must still reach
 * the clipboard.
 *
 * The guard follows the addon's own `onBeforeSearch`/`onAfterSearch` pair rather than wrapping the navigation calls
 * this pane makes, because the addon re-runs the cached query by itself 200ms after every `onWriteParsed` and
 * `onResize`. A wrapper would miss those, and a Terminal that keeps printing would repeatedly overwrite the clipboard
 * with the active match while the search bar is open.
 *
 * `SearchAddon` selects through `Terminal.select()`, which fires `onSelectionChange` synchronously between the two
 * events, so the flag is only raised for one synchronous block. The microtask reset releases it even when a search
 * throws: an invalid regular expression never reaches `onAfterSearch`, and is far too short for a user gesture to fall
 * inside it.
 */
export function createTerminalSearchSelectionGuard(): TerminalSearchSelectionGuard {
    let isSearchSelection = false;
    return {
        beginSearchSelection() {
            isSearchSelection = true;
            queueMicrotask(() => {
                isSearchSelection = false;
            });
        },
        endSearchSelection() {
            isSearchSelection = false;
        },
        isSearchSelection: () => isSearchSelection,
    };
}

type OpenTerminalSearchHandler = () => void;
const openHandlers = new Map<string, OpenTerminalSearchHandler>();

/**
 * Connects the command registry to the mounted xterm pane without exposing Terminal content or search state outside the
 * Renderer. Identity-checked cleanup prevents a stale pane from removing a newer handler when a Terminal tab changes in
 * place.
 */
export function registerTerminalSearchHandler(
    terminalId: string,
    handler: OpenTerminalSearchHandler,
): () => void {
    openHandlers.set(terminalId, handler);
    return () => {
        if (openHandlers.get(terminalId) === handler) openHandlers.delete(terminalId);
    };
}

export function openTerminalSearch(terminalId: string): void {
    openHandlers.get(terminalId)?.();
}

export function terminalSearchResultLabel(
    t: Translate,
    query: string,
    results: TerminalSearchResults,
): string {
    if (!query) return '';
    if (results.error) return results.error;
    if (results.resultCount === 0) return t('terminal.search.noResults');
    if (results.resultCount > TERMINAL_SEARCH_HIGHLIGHT_LIMIT)
        return t('terminal.search.resultsOverLimit', { count: TERMINAL_SEARCH_HIGHLIGHT_LIMIT });
    if (results.resultIndex < 0)
        return t('terminal.search.resultCount', { count: results.resultCount });
    return `${results.resultIndex + 1}/${results.resultCount}`;
}

/**
 * Whether the find bar shows its count in the danger tone: the query matches nothing or cannot be searched.
 */
export function isTerminalSearchNoMatch(query: string, results: TerminalSearchResults): boolean {
    return query !== '' && (Boolean(results.error) || results.resultCount === 0);
}

/**
 * Whether there is a match for the find bar's previous and next buttons to step to.
 */
export function isTerminalSearchNavigable(query: string, results: TerminalSearchResults): boolean {
    return query !== '' && !results.error && results.resultCount > 0;
}
