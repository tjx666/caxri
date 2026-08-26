import type { BootstrapState, ServerEvent } from '@caxri/protocol';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    it('invalidates every cached read after private changefeed recovery uses a snapshot', () => {
        const queryClient = new QueryClient();
        const agentActions = ['agentActions.list', { terminalId: 'terminal-a' }] as const;
        const files = ['files.browse', { sessionId: 'session-a' }] as const;
        const git = ['git.summary', { sessionId: 'session-a' }] as const;
        queryClient.setQueryData(agentActions, { actions: [] });
        queryClient.setQueryData(files, { entries: [] });
        queryClient.setQueryData(git, { status: 'clean' });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });

        expect(queryClient.getQueryData(agentActions)).toBeUndefined();
        expect(queryClient.getQueryState(files)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(git)?.isInvalidated).toBe(true);
        unsubscribe();
    });

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
                changes: [{ path: '/project-p/file.ts', kind: 'update' }],
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

    it('targets Resource Explorer content invalidation by view, root scope, and changed directory', () => {
        vi.useFakeTimers();
        const queryClient = new QueryClient();
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
        const filesView = 'publisher.files.explorer';
        queryClient.setQueryData(
            [
                'viewContainers.viewOperation',
                {
                    viewId: filesView,
                    operation: 'files.list',
                    arguments: { directory: '/project/src' },
                    contextKey: 'session-a:project-p',
                },
            ],
            [],
        );
        queryClient.setQueryData(
            [
                'viewContainers.viewOperation',
                {
                    viewId: filesView,
                    operation: 'files.list',
                    arguments: { directory: '/project/docs' },
                    contextKey: 'session-a:project-p',
                },
            ],
            [],
        );
        queryClient.setQueryData(
            [
                'viewContainers.viewOperation',
                {
                    viewId: filesView,
                    operation: 'files.search',
                    arguments: { mode: 'name', query: 'x' },
                    contextKey: 'session-a:project-p',
                },
            ],
            {},
        );
        queryClient.setQueryData(
            [
                'viewContainers.viewOperation',
                {
                    viewId: 'publisher.git.view',
                    operation: 'git.summary',
                    arguments: {},
                    contextKey: 'session-a:project-p',
                },
            ],
            {},
        );
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-a',
                sessions: [{ id: 'session-a', workbenchProjectId: 'project-p' }],
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
                changes: [{ path: '/project/src/index.ts', kind: 'update' }],
            },
        });
        mocks.state.handler?.({
            event: 'files.changed',
            payload: {
                sessionId: 'session-a',
                workbenchProjectId: 'project-p',
                overflow: false,
                changes: [{ path: '/project/src/other.ts', kind: 'update' }],
            },
        });
        vi.advanceTimersByTime(150);
        expect(invalidateQueries).toHaveBeenCalledTimes(1);

        expect(
            queryClient.getQueryState([
                'viewContainers.viewOperation',
                {
                    viewId: filesView,
                    operation: 'files.list',
                    arguments: { directory: '/project/src' },
                    contextKey: 'session-a:project-p',
                },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'viewContainers.viewOperation',
                {
                    viewId: filesView,
                    operation: 'files.list',
                    arguments: { directory: '/project/docs' },
                    contextKey: 'session-a:project-p',
                },
            ])?.isInvalidated,
        ).toBe(false);
        expect(
            queryClient.getQueryState([
                'viewContainers.viewOperation',
                {
                    viewId: 'publisher.git.view',
                    operation: 'git.summary',
                    arguments: {},
                    contextKey: 'session-a:project-p',
                },
            ])?.isInvalidated,
        ).toBe(false);

        expect(
            queryClient.getQueryState([
                'viewContainers.viewOperation',
                {
                    viewId: filesView,
                    operation: 'files.search',
                    arguments: { mode: 'name', query: 'x' },
                    contextKey: 'session-a:project-p',
                },
            ])?.isInvalidated,
        ).toBe(true);
        unsubscribe();
    });

    it('does not invalidate a controlled view for a no-session context', () => {
        const queryClient = new QueryClient();
        const queryKey = [
            'viewContainers.viewOperation',
            {
                viewId: 'publisher.git.sourceControl',
                operation: 'git.summary',
                arguments: { refresh: 0 },
                contextKey: 'session-a:project-p',
            },
        ] as const;
        queryClient.setQueryData(queryKey, []);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'viewContainers.viewChanged',
            payload: {
                viewId: 'publisher.git.sourceControl',
                eventId: 'view-event-no-session',
                extensionGeneration: 2,
                context: { kind: 'no-session' },
                change: { kind: 'content' },
            },
        });

        expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
        unsubscribe();
    });

    it('invalidates only the scoped generic Source Control reads after provider content changes', () => {
        const queryClient = new QueryClient();
        const matchingSnapshot = [
            'viewContainers.viewOperation',
            {
                viewId: 'publisher.git.sourceControl',
                operation: 'source.snapshot',
                arguments: { refresh: 0 },
                contextKey: 'session-a:project-p',
                cacheRevision: '[]:0',
            },
        ] as const;
        const matchingHistory = [
            'viewContainers.viewOperation',
            {
                viewId: 'publisher.git.sourceControl',
                operation: 'source.historyPage',
                arguments: { historyId: 'repo-1', offset: 0, pageSize: 50, revision: '1' },
                contextKey: 'session-a:project-p',
            },
        ] as const;
        const otherView = [
            'viewContainers.viewOperation',
            {
                viewId: 'publisher.other.sourceControl',
                operation: 'source.snapshot',
                arguments: { refresh: 0 },
                contextKey: 'session-a:project-p',
            },
        ] as const;
        const otherScope = [
            'viewContainers.viewOperation',
            {
                viewId: 'publisher.git.sourceControl',
                operation: 'source.snapshot',
                arguments: { refresh: 0 },
                contextKey: 'session-b:project-p',
            },
        ] as const;
        for (const key of [matchingSnapshot, matchingHistory, otherView, otherScope])
            queryClient.setQueryData(key, {});
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'viewContainers.viewChanged',
            payload: {
                viewId: 'publisher.git.sourceControl',
                eventId: 'view-event-content',
                extensionGeneration: 2,
                context: {
                    kind: 'session',
                    sessionId: 'session-a',
                    workbenchProjectId: 'project-p',
                },
                change: { kind: 'content' },
            },
        });

        expect(queryClient.getQueryState(matchingSnapshot)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(matchingHistory)?.isInvalidated).toBe(false);
        expect(queryClient.getQueryState(otherView)?.isInvalidated).toBe(false);
        expect(queryClient.getQueryState(otherScope)?.isInvalidated).toBe(false);
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

    it('invalidates every transcript after a Server reconnect closes a journal-gap race', () => {
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
