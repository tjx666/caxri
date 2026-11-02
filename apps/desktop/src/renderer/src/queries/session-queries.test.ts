import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { removeSessionQueries } from './session-queries';

describe('removeSessionQueries', () => {
    it('removes cached queries only for the given sessionIds', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['git.summary', { sessionId: 'session-a' }], { status: 'clean' });
        queryClient.setQueryData(['git.diffDocument', { sessionId: 'session-a' }], { patch: '' });
        queryClient.setQueryData(['git.summary', { sessionId: 'session-b' }], { status: 'dirty' });
        queryClient.setQueryData(['files.exclude'], { patterns: [] });

        removeSessionQueries(queryClient, ['session-a']);

        expect(
            queryClient.getQueryData(['git.summary', { sessionId: 'session-a' }]),
        ).toBeUndefined();
        expect(
            queryClient.getQueryData(['git.diffDocument', { sessionId: 'session-a' }]),
        ).toBeUndefined();
        expect(queryClient.getQueryData(['git.summary', { sessionId: 'session-b' }])).toEqual({
            status: 'dirty',
        });
        expect(queryClient.getQueryData(['files.exclude'])).toEqual({ patterns: [] });
    });

    /**
     * Extension Tree branches deliberately outlive the default garbage-collection window, and this sweep is what bounds
     * that for a deleted Session. They carry no `sessionId` parameter: the Session lives inside the context key.
     */
    it('removes branches a deleted Session identifies through its context key', () => {
        const queryClient = new QueryClient();
        const keys = ['session-a:project-a:1', 'session-b:project-a:1', 'project-a'].map(
            (contextKey) =>
                ['viewContainers.treeChildren', { contextKey, parentHandle: 'root' }] as const,
        );
        for (const key of keys) queryClient.setQueryData(key, [{ handle: 'repository' }]);

        removeSessionQueries(queryClient, ['session-a']);

        expect(keys.map((key) => queryClient.getQueryData(key) !== undefined)).toEqual([
            false,
            true,
            true,
        ]);
    });

    it('is a no-op when no sessionIds are removed', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['git.summary', { sessionId: 'session-a' }], { status: 'clean' });

        removeSessionQueries(queryClient, []);

        expect(queryClient.getQueryData(['git.summary', { sessionId: 'session-a' }])).toEqual({
            status: 'clean',
        });
    });
});
