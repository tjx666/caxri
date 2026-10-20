import { beforeEach, describe, expect, it } from 'vitest';

import {
    pruneKeepAliveSessions,
    retainKeepAliveSession,
    SESSION_KEEP_ALIVE_LIMIT,
    useSessionKeepAliveStore,
} from '../session-keep-alive';

function retained(): readonly string[] {
    return useSessionKeepAliveStore.getState().retained;
}

beforeEach(() => {
    useSessionKeepAliveStore.setState({ retained: [] });
});

describe('Session keep-alive', () => {
    it('keeps the most recently selected Sessions and evicts past the limit', () => {
        const ids = Array.from({ length: SESSION_KEEP_ALIVE_LIMIT + 1 }, (_, index) => `s${index}`);
        for (const id of ids) retainKeepAliveSession(id);

        expect(retained()).toEqual(ids.slice(1).toReversed());
    });

    it('promotes a Session that is already retained instead of duplicating it', () => {
        for (const id of ['a', 'b', 'c']) retainKeepAliveSession(id);

        retainKeepAliveSession('a');

        expect(retained()).toEqual(['a', 'c', 'b']);
    });

    it('returns the identical array when the visible Session is re-selected', () => {
        retainKeepAliveSession('a');
        const before = retained();

        retainKeepAliveSession('a');

        // Identity is the contract: a new array here re-renders every retained Workbench for no reason.
        expect(retained()).toBe(before);
    });

    it('ignores a missing Session id rather than retaining a hole', () => {
        retainKeepAliveSession('a');

        retainKeepAliveSession(undefined);

        expect(retained()).toEqual(['a']);
    });

    it('drops Sessions the Server no longer reports so their Terminals are released', () => {
        for (const id of ['a', 'b', 'c']) retainKeepAliveSession(id);

        pruneKeepAliveSessions(new Set(['c', 'a']));

        expect(retained()).toEqual(['c', 'a']);
    });

    it('leaves the list untouched when every retained Session is still live', () => {
        for (const id of ['a', 'b']) retainKeepAliveSession(id);
        const before = retained();

        pruneKeepAliveSessions(new Set(['a', 'b', 'unrelated']));

        expect(retained()).toBe(before);
    });
});
