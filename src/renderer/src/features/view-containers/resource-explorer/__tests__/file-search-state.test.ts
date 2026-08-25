import { beforeEach, describe, expect, it } from 'vitest';

import { closeFileSearch, requestFileSearchFocus, useFileSearchStore } from '../file-search-state';

describe('file search state', () => {
    beforeEach(() => {
        useFileSearchStore.setState({ activeSessionId: undefined, focusRevision: 0 });
    });

    it('focuses a Session and bumps the revision', () => {
        requestFileSearchFocus('session-1');

        expect(useFileSearchStore.getState().activeSessionId).toBe('session-1');
        expect(useFileSearchStore.getState().focusRevision).toBe(1);
    });

    it('bumps the revision again even when the active Session id is unchanged', () => {
        requestFileSearchFocus('session-1');
        requestFileSearchFocus('session-1');

        // A repeat focus request (e.g. the shortcut fired twice) must still re-trigger the
        // search input's focus effect, which keys off `focusRevision` rather than the id.
        expect(useFileSearchStore.getState().activeSessionId).toBe('session-1');
        expect(useFileSearchStore.getState().focusRevision).toBe(2);
    });

    it('bumps the revision when focus moves to a different Session', () => {
        requestFileSearchFocus('session-1');
        requestFileSearchFocus('session-2');

        expect(useFileSearchStore.getState().activeSessionId).toBe('session-2');
        expect(useFileSearchStore.getState().focusRevision).toBe(2);
    });

    it('closes the panel when the given Session matches the active one', () => {
        requestFileSearchFocus('session-1');

        closeFileSearch('session-1');

        expect(useFileSearchStore.getState().activeSessionId).toBeUndefined();
    });

    it('leaves the panel open when the given Session does not match the active one', () => {
        requestFileSearchFocus('session-1');

        closeFileSearch('session-2');

        expect(useFileSearchStore.getState().activeSessionId).toBe('session-1');
    });

    it('is a no-op to close when no Session is active', () => {
        const before = useFileSearchStore.getState();

        closeFileSearch('session-1');

        expect(useFileSearchStore.getState()).toBe(before);
    });
});
