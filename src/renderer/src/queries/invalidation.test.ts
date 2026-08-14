import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '@shared/ipc';
import type { BootstrapState } from '@shared/types';

const mocks = vi.hoisted(() => {
    const state: { handler?: (event: RuntimeEvent) => void } = {};
    return {
        state,
        onEvent: vi.fn((handler: (event: RuntimeEvent) => void) => {
            state.handler = handler;
            return () => undefined;
        }),
    };
});

vi.mock('../lib/caxri', () => ({ caxri: mocks }));

import { useWorkbenchStore } from '../stores/workbench';
import { removeSessionQueries, subscribeRuntimeQueryInvalidation } from './invalidation';

afterEach(() => {
    vi.useRealTimers();
    useWorkbenchStore.setState({ bootstrap: undefined });
});

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

    it('is a no-op when no sessionIds are removed', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['git.summary', { sessionId: 'session-a' }], { status: 'clean' });

        removeSessionQueries(queryClient, []);

        expect(queryClient.getQueryData(['git.summary', { sessionId: 'session-a' }])).toEqual({
            status: 'clean',
        });
    });
});

describe('subscribeRuntimeQueryInvalidation', () => {
    it('invalidates every Session currently routed to the changed Workbench Project', () => {
        vi.useFakeTimers();
        const queryClient = new QueryClient();
        queryClient.setQueryData(['git.summary', { sessionId: 'session-a' }], { status: 'clean' });
        queryClient.setQueryData(['git.summary', { sessionId: 'session-b' }], { status: 'clean' });
        queryClient.setQueryData(['git.summary', { sessionId: 'session-other' }], {
            status: 'clean',
        });
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-a',
                sessions: [
                    { id: 'session-a', workbenchProjectId: 'project-p' },
                    { id: 'session-b', workbenchProjectId: 'project-other' },
                    { id: 'session-other', workbenchProjectId: 'project-other' },
                ],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'files.changed',
            payload: {
                sessionId: 'session-a',
                workbenchProjectId: 'project-p',
                overflow: false,
                changes: [],
            },
        });
        useWorkbenchStore.setState((state) => ({
            bootstrap: {
                ...state.bootstrap!,
                sessions: state.bootstrap!.sessions.map((session) =>
                    session.id === 'session-b'
                        ? { ...session, workbenchProjectId: 'project-p' }
                        : session,
                ),
            },
        }));
        vi.advanceTimersByTime(150);

        expect(
            queryClient.getQueryState(['git.summary', { sessionId: 'session-a' }])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['git.summary', { sessionId: 'session-b' }])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['git.summary', { sessionId: 'session-other' }])
                ?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });
});
