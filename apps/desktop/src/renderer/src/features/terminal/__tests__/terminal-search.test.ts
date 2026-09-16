import { describe, expect, it, vi } from 'vitest';

import {
    createTerminalSearchSelectionGuard,
    initialTerminalSearchState,
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
});

/**
 * Stands in for `SearchAddon`'s search lifecycle. The addon emits the same pair for an explicit navigation and for the
 * re-search it runs itself after Terminal output or a resize, which is exactly why the guard follows the events rather
 * than wrapping the navigation calls the pane makes.
 */
function fakeSearchLifecycle() {
    const listeners = { after: new Set<() => void>(), before: new Set<() => void>() };
    const subscribe = (bucket: Set<() => void>, listener: () => void) => {
        bucket.add(listener);
        return { dispose: () => bucket.delete(listener) };
    };
    return {
        emitAfterSearch: () => listeners.after.forEach((listener) => listener()),
        emitBeforeSearch: () => listeners.before.forEach((listener) => listener()),
        onAfterSearch: (listener: () => void) => subscribe(listeners.after, listener),
        onBeforeSearch: (listener: () => void) => subscribe(listeners.before, listener),
    };
}

describe('Terminal search selection guard', () => {
    it('marks only the selection the search addon produces', () => {
        const guard = createTerminalSearchSelectionGuard();
        const search = fakeSearchLifecycle();
        guard.watch(search);

        expect(guard.isSearchSelection()).toBe(false);
        search.emitBeforeSearch();
        expect(guard.isSearchSelection()).toBe(true);
        search.emitAfterSearch();
        expect(guard.isSearchSelection()).toBe(false);
    });

    it('releases the guard when a search throws before it completes', async () => {
        const guard = createTerminalSearchSelectionGuard();
        const search = fakeSearchLifecycle();
        guard.watch(search);

        // An invalid regular expression never reaches `onAfterSearch`.
        search.emitBeforeSearch();
        // A mouse selection can never land inside the search's own microtask window.
        await Promise.resolve();
        expect(guard.isSearchSelection()).toBe(false);
    });

    it('stops following a disposed search addon', () => {
        const guard = createTerminalSearchSelectionGuard();
        const search = fakeSearchLifecycle();

        guard.watch(search)();
        search.emitBeforeSearch();
        expect(guard.isSearchSelection()).toBe(false);
    });
});
