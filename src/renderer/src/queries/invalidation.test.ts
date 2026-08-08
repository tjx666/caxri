import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { removeSessionQueries } from './invalidation';

describe('removeSessionQueries', () => {
    it('removes cached queries only for the given sessionIds', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['git.summary', { sessionId: 'session-a' }], { status: 'clean' });
        queryClient.setQueryData(['git.diff', { sessionId: 'session-a' }], { patch: '' });
        queryClient.setQueryData(['git.summary', { sessionId: 'session-b' }], { status: 'dirty' });
        queryClient.setQueryData(['files.exclude'], { patterns: [] });

        removeSessionQueries(queryClient, ['session-a']);

        expect(
            queryClient.getQueryData(['git.summary', { sessionId: 'session-a' }]),
        ).toBeUndefined();
        expect(queryClient.getQueryData(['git.diff', { sessionId: 'session-a' }])).toBeUndefined();
        expect(queryClient.getQueryData(['git.summary', { sessionId: 'session-b' }])).toEqual({
            status: 'dirty',
        });
        expect(queryClient.getQueryData(['files.exclude'])).toEqual({ patterns: [] });
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
