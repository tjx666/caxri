import { describe, expect, it, vi } from 'vitest';

import {
    createTerminalSearchSelectionGuard,
    initialTerminalSearchState,
    isTerminalSearchNavigable,
    isTerminalSearchNoMatch,
    openTerminalSearch,
    registerTerminalSearchHandler,
    terminalSearchReducer,
    terminalSearchResultLabel,
} from '../terminal-search';

describe('Terminal search state', () => {
    it('preserves a Terminal-local query across close while reset clears every option', () => {
        let state = terminalSearchReducer(initialTerminalSearchState, { type: 'open' });
        state = terminalSearchReducer(state, { type: 'query', query: 'Needle' });
        state = terminalSearchReducer(state, { type: 'toggle', option: 'caseSensitive' });
        state = terminalSearchReducer(state, { type: 'close' });

        expect(state).toMatchObject({
            caseSensitive: true,
            focusRevision: 1,
            open: false,
            query: 'Needle',
        });
        expect(terminalSearchReducer(state, { type: 'reset' })).toEqual(initialTerminalSearchState);
    });

    it('uses identity-checked handler cleanup when a mounted Terminal changes in place', () => {
        const oldHandler = vi.fn();
        const currentHandler = vi.fn();
        const unregisterOld = registerTerminalSearchHandler('terminal-1', oldHandler);
        const unregisterCurrent = registerTerminalSearchHandler('terminal-1', currentHandler);

        unregisterOld();
        openTerminalSearch('terminal-1');
        expect(oldHandler).not.toHaveBeenCalled();
        expect(currentHandler).toHaveBeenCalledOnce();

        unregisterCurrent();
        openTerminalSearch('terminal-1');
        expect(currentHandler).toHaveBeenCalledOnce();
    });

    it('formats current, empty, invalid, and highlight-limit result states', () => {
        expect(terminalSearchResultLabel('', { resultCount: 0, resultIndex: -1 })).toBe('');
        expect(terminalSearchResultLabel('x', { resultCount: 0, resultIndex: -1 })).toBe(
            'No results',
        );
        expect(terminalSearchResultLabel('x', { resultCount: 4, resultIndex: 1 })).toBe('2/4');
        expect(terminalSearchResultLabel('x', { resultCount: 1_000, resultIndex: 0 })).toBe(
            '1/1000',
        );
        expect(terminalSearchResultLabel('x', { resultCount: 1_001, resultIndex: 0 })).toBe(
            '1000+ results',
        );
        expect(
            terminalSearchResultLabel('(', {
                error: 'Invalid regular expression',
                resultCount: 0,
                resultIndex: -1,
            }),
        ).toBe('Invalid regular expression');
    });

    it('steps only through real matches and flags empty or invalid queries as no match', () => {
        const none = { resultCount: 0, resultIndex: -1 };
        const some = { resultCount: 3, resultIndex: 0 };
        const invalid = { error: 'Invalid regular expression', resultCount: 0, resultIndex: -1 };
        expect(isTerminalSearchNavigable('', none)).toBe(false);
        expect(isTerminalSearchNavigable('x', none)).toBe(false);
        expect(isTerminalSearchNavigable('x', some)).toBe(true);
        expect(isTerminalSearchNavigable('(', invalid)).toBe(false);
        expect(isTerminalSearchNoMatch('', none)).toBe(false);
        expect(isTerminalSearchNoMatch('x', none)).toBe(true);
        expect(isTerminalSearchNoMatch('x', some)).toBe(false);
        expect(isTerminalSearchNoMatch('(', invalid)).toBe(true);
    });
});

/**
 * The pane drives these from `SearchAddon`'s own `onBeforeSearch`/`onAfterSearch`, which the addon emits for an
 * explicit navigation and for the re-search it runs itself after Terminal output or a resize alike.
 */
describe('Terminal search selection guard', () => {
    it('marks only the selection the search addon produces', () => {
        const guard = createTerminalSearchSelectionGuard();

        expect(guard.isSearchSelection()).toBe(false);
        guard.beginSearchSelection();
        expect(guard.isSearchSelection()).toBe(true);
        guard.endSearchSelection();
        expect(guard.isSearchSelection()).toBe(false);
    });

    it('releases the guard when a search throws before it completes', async () => {
        const guard = createTerminalSearchSelectionGuard();

        // An invalid regular expression never reaches `onAfterSearch`.
        guard.beginSearchSelection();
        // A mouse selection can never land inside the search's own microtask window.
        await Promise.resolve();
        expect(guard.isSearchSelection()).toBe(false);
    });
});
