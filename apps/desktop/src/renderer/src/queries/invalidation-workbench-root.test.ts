import type { ServerEvent } from '@caxri/protocol';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state: { handler?: (event: ServerEvent) => void } = {};
    return {
        state,
        onEvent: vi.fn((handler: (event: ServerEvent) => void) => {
            state.handler = handler;
            return () => {};
        }),
    };
});

vi.mock('../lib/caxri', () => ({ caxri: mocks }));

import { caxriQueryKey } from './client';
import { subscribeRuntimeQueryInvalidation } from './invalidation';

it('refetches a mounted Session read once its Workbench Root changes', async () => {
    const queryClient = new QueryClient();
    const branches = ['feature/worktree', 'main'];
    const queryFunction = vi.fn(() => Promise.resolve({ branch: branches.shift() }));
    const observer = new QueryObserver(queryClient, {
        queryKey: caxriQueryKey('git.overview', { sessionId: 'session-a' }),
        queryFn: queryFunction,
        staleTime: Infinity,
    });
    const results: Array<string | undefined> = [];
    const unsubscribeObserver = observer.subscribe((result) => {
        results.push(result.data?.branch);
    });
    await vi.waitFor(() => expect(results).toContain('feature/worktree'));
    const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

    mocks.state.handler?.({
        event: 'workbench.changed',
        payload: {
            sessionId: 'session-a',
            workbenchRootProjectId: 'project-a',
            reason: 'selected',
        },
    });

    // Nothing else re-renders the status bar after the switch, so the mounted read itself must move to the new root.
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.branch).toBe('main'));
    unsubscribe();
    unsubscribeObserver();
});
