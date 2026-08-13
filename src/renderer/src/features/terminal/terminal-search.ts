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

type OpenTerminalSearchHandler = () => void;
const openHandlers = new Map<string, OpenTerminalSearchHandler>();

/**
 * Connects the command registry to the mounted xterm pane without exposing Terminal content or
 * search state outside the Renderer. Identity-checked cleanup prevents a stale pane from removing
 * a newer handler when a Terminal tab changes in place.
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

export function terminalSearchResultLabel(query: string, results: TerminalSearchResults): string {
    if (!query) return '';
    if (results.error) return results.error;
    if (results.resultCount === 0) return 'No results';
    if (results.resultCount > TERMINAL_SEARCH_HIGHLIGHT_LIMIT)
        return `${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+ results`;
    if (results.resultIndex < 0) return `${results.resultCount} results`;
    return `${results.resultIndex + 1}/${results.resultCount}`;
}
