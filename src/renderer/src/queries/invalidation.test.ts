import type { RuntimeEvent } from '@shared/ipc';
import type { BootstrapState } from '@shared/types';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state: { handler?: (event: RuntimeEvent) => void } = {};
    return {
        state,
        onEvent: vi.fn((handler: (event: RuntimeEvent) => void) => {
            state.handler = handler;
            return () => {};
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
    it('drops cached Agent Actions only after a valid settings change', () => {
        const queryClient = new QueryClient();
        const key = ['agentActions.list', { terminalId: 'terminal-a' }];
        queryClient.setQueryData(key, { actions: [{ invocation: '/old' }] });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'settings.changed',
            payload: { source: '{}', error: 'invalid settings' },
        });
        expect(queryClient.getQueryData(key)).toBeDefined();

        mocks.state.handler?.({ event: 'settings.changed', payload: { source: '{}' } });
        expect(queryClient.getQueryData(key)).toBeUndefined();
        unsubscribe();
    });

    it('invalidates every Session currently routed to the changed Workbench Project, but never Git queries', () => {
        vi.useFakeTimers();
        const queryClient = new QueryClient();
        queryClient.setQueryData(['files.browse', { sessionId: 'session-a' }], { entries: [] });
        queryClient.setQueryData(['files.browse', { sessionId: 'session-b' }], { entries: [] });
        queryClient.setQueryData(['files.browse', { sessionId: 'session-other' }], {
            entries: [],
        });
        queryClient.setQueryData(['git.summary', { sessionId: 'session-a' }], { status: 'clean' });
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
            queryClient.getQueryState(['files.browse', { sessionId: 'session-a' }])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['files.browse', { sessionId: 'session-b' }])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['files.browse', { sessionId: 'session-other' }])
                ?.isInvalidated,
        ).toBe(false);
        // `files.changed` no longer drives Git invalidation — that is `git.changed`'s job (see below).
        expect(
            queryClient.getQueryState(['git.summary', { sessionId: 'session-a' }])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('invalidates Git queries for every Session named in a git.changed event, without debouncing', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['git.summary', { sessionId: 'session-a' }], { status: 'clean' });
        queryClient.setQueryData(['git.overview', { sessionId: 'session-a' }], { status: 'clean' });
        queryClient.setQueryData(['git.diffDocument', { sessionId: 'session-a' }], { patch: '' });
        queryClient.setQueryData(['git.blame', { sessionId: 'session-a' }], { author: 'x' });
        queryClient.setQueryData(['git.summary', { sessionId: 'session-b' }], { status: 'clean' });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'git.changed',
            payload: {
                sessionIds: ['session-a'],
                repositoryIds: ['repo-1'],
                scope: 'status',
            },
        });

        expect(
            queryClient.getQueryState(['git.summary', { sessionId: 'session-a' }])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['git.overview', { sessionId: 'session-a' }])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['git.diffDocument', { sessionId: 'session-a' }])
                ?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['git.blame', { sessionId: 'session-a' }])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['git.summary', { sessionId: 'session-b' }])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('invalidates only the refreshed Session Project Status query', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['projectStatus.summary', { sessionId: 'session-a' }], {});
        queryClient.setQueryData(
            ['projectStatus.summary', { sessionId: 'session-a', refreshToken: 'refresh-1' }],
            {},
        );
        queryClient.setQueryData(['projectStatus.summary', { sessionId: 'session-b' }], {});
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'projectStatus.changed',
            payload: { sessionId: 'session-a' },
        });

        expect(
            queryClient.getQueryState(['projectStatus.summary', { sessionId: 'session-a' }])
                ?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'projectStatus.summary',
                { sessionId: 'session-a', refreshToken: 'refresh-1' },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['projectStatus.summary', { sessionId: 'session-b' }])
                ?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('invalidates only the transcript query for the changed Terminal', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-a', withContent: true }],
            { content: 'old' },
        );
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-b', withContent: true }],
            { content: 'other' },
        );
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-a' },
        });

        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-a', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-b', withContent: true },
            ])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('invalidates every transcript after a Host reconnect closes a journal-gap race', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-a', withContent: true }],
            { content: 'old-a' },
        );
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-b', withContent: true }],
            { content: 'old-b' },
        );
        queryClient.setQueryData(['files.browse', { sessionId: 'session-a' }], { entries: [] });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'host.connectionChanged',
            payload: { status: 'replaced' },
        });

        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-a', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-b', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['files.browse', { sessionId: 'session-a' }])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('invalidates the rebound Terminal transcript on a record-scoped state change', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-a', withContent: true }],
            { content: 'old-a' },
        );
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-b', withContent: true }],
            { content: 'old-b' },
        );
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: ['terminal-a'] },
        });

        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-a', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-b', withContent: true },
            ])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('invalidates every transcript when a full state change may replace Terminal bindings', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-a', withContent: true }],
            { content: 'old-a' },
        );
        queryClient.setQueryData(
            ['terminal.agentTranscript', { terminalId: 'terminal-b', withContent: true }],
            { content: 'old-b' },
        );
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'terminal.create' },
        });

        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-a', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'terminal.agentTranscript',
                { terminalId: 'terminal-b', withContent: true },
            ])?.isInvalidated,
        ).toBe(true);
        unsubscribe();
    });
});
