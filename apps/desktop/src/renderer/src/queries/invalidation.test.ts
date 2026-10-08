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

import { projectSearchQueryKey } from '../features/project-search/project-search-query';
import { useWorkbenchStore } from '../stores/workbench';
import { caxriQueryKey } from './client';
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

describe('subscribeRuntimeQueryInvalidation', () => {
    it('invalidates badges only for the emitting view and Workbench scope', () => {
        const client = new QueryClient();
        const keys = [
            ['git.view', 'badge.snapshot', 'session-a:project-a'],
            ['git.view', 'badge.snapshot', 'session-b:project-b'],
            ['status.view', 'badge.snapshot', 'session-a:project-a'],
            ['git.view', 'source.snapshot', 'session-a:project-a'],
        ].map(([viewId, operation, contextKey]) => [
            'viewContainers.viewOperation',
            { viewId, operation, contextKey, arguments: {} },
        ]);
        for (const key of keys) client.setQueryData(key, { count: 1 });
        const unsubscribe = subscribeRuntimeQueryInvalidation(client);
        mocks.state.handler?.({
            event: 'viewContainers.viewChanged',
            payload: {
                viewId: 'git.view',
                eventId: 'badge-change',
                extensionGeneration: 1,
                context: {
                    kind: 'session',
                    sessionId: 'session-a',
                    workbenchProjectId: 'project-a',
                },
                change: { kind: 'badge' },
            },
        });
        expect(keys.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([
            true,
            false,
            false,
            false,
        ]);
        unsubscribe();
        client.clear();
    });
    it('invalidates every cached read after private changefeed recovery uses a snapshot', () => {
        const queryClient = new QueryClient();
        const agentActions = ['agentActions.list', { terminalId: 'terminal-a' }] as const;
        const files = caxriQueryKey('files.list', { sessionId: 'session-a' });
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

    it('re-asks for delivery status after a settings change, so an ignored check applies at once', () => {
        const queryClient = new QueryClient();
        const summary = ['projectStatus.summary', { sessionId: 'session-a' }] as const;
        const pullRequests = ['session.pullRequests', undefined] as const;
        queryClient.setQueryData(summary, { repositories: [] });
        queryClient.setQueryData(pullRequests, { pullRequests: {} });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({ event: 'settings.changed', payload: { source: '{}' } });

        expect(queryClient.getQueryState(summary)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(pullRequests)?.isInvalidated).toBe(true);
        unsubscribe();
    });

    it.each(['session.create', 'terminal.moveToNewSession', 'session.unarchive'] as const)(
        're-asks for Session pull requests after %s',
        (reason) => {
            const queryClient = new QueryClient();
            const pullRequests = ['session.pullRequests', undefined] as const;
            queryClient.setQueryData(pullRequests, { pullRequests: {} });
            const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

            mocks.state.handler?.({
                event: 'state.changed',
                payload: { kind: 'full', reason },
            });

            expect(queryClient.getQueryState(pullRequests)?.isInvalidated).toBe(true);
            unsubscribe();
        },
    );

    it('re-asks for Session pull requests after a Workbench Root change', () => {
        const queryClient = new QueryClient();
        const pullRequests = ['session.pullRequests', undefined] as const;
        queryClient.setQueryData(pullRequests, { pullRequests: {} });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);
        mocks.state.handler?.({
            event: 'workbench.changed',
            payload: {
                sessionId: 'session-a',
                workbenchProjectId: 'project-b',
                reason: 'selected',
            },
        });
        expect(queryClient.getQueryState(pullRequests)?.isInvalidated).toBe(true);
        unsubscribe();
    });

    it('invalidates every Session currently routed to the changed Workbench Project, but never Git queries', () => {
        vi.useFakeTimers();
        const queryClient = new QueryClient();
        queryClient.setQueryData(caxriQueryKey('files.list', { sessionId: 'session-a' }), {
            entries: [],
        });
        queryClient.setQueryData(caxriQueryKey('files.list', { sessionId: 'session-b' }), {
            entries: [],
        });
        queryClient.setQueryData(caxriQueryKey('files.list', { sessionId: 'session-other' }), {
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
            queryClient.getQueryState(caxriQueryKey('files.list', { sessionId: 'session-a' }))
                ?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(caxriQueryKey('files.list', { sessionId: 'session-b' }))
                ?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(caxriQueryKey('files.list', { sessionId: 'session-other' }))
                ?.isInvalidated,
        ).toBe(false);
        // `files.changed` no longer drives Git invalidation: that is `git.changed`'s job (see below).
        expect(
            queryClient.getQueryState(['git.summary', { sessionId: 'session-a' }])?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('invalidates every Files listing in the affected Workbench Project after watcher overflow', () => {
        vi.useFakeTimers();
        const queryClient = new QueryClient();
        const observedList = caxriQueryKey('files.list', {
            sessionId: 'session-a',
            directory: '/project/src',
        });
        const firstList = caxriQueryKey('files.list', {
            sessionId: 'session-a',
            directory: '/project/docs',
        });
        const siblingList = caxriQueryKey('files.list', {
            sessionId: 'session-b',
            directory: '/project/tests',
        });
        const unrelatedList = caxriQueryKey('files.list', {
            sessionId: 'session-other',
            directory: '/other',
        });
        for (const key of [observedList, firstList, siblingList, unrelatedList])
            queryClient.setQueryData(key, { entries: [] });
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-a',
                sessions: [
                    { id: 'session-a', workbenchProjectId: 'project-p' },
                    { id: 'session-b', workbenchProjectId: 'project-p' },
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
                overflow: true,
                changes: [{ path: '/project/src/observed.ts', kind: 'update' }],
            },
        });
        vi.advanceTimersByTime(150);

        expect(queryClient.getQueryState(observedList)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(firstList)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(siblingList)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(unrelatedList)?.isInvalidated).toBe(false);
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

    it('invalidates the Project-shared Files listing when another Session of the Project changes files', () => {
        vi.useFakeTimers();
        const queryClient = new QueryClient();
        const sharedListing = [
            'viewContainers.viewOperation',
            {
                viewId: 'publisher.files.explorer',
                operation: 'files.list',
                arguments: { directory: '/project/src' },
                contextKey: 'project-p',
            },
        ] as const;
        const otherProjectListing = [
            'viewContainers.viewOperation',
            {
                viewId: 'publisher.files.explorer',
                operation: 'files.list',
                arguments: { directory: '/project/src' },
                contextKey: 'project-q',
            },
        ] as const;
        queryClient.setQueryData(sharedListing, []);
        queryClient.setQueryData(otherProjectListing, []);
        useWorkbenchStore.setState({
            bootstrap: {
                selectedSessionId: 'session-a',
                sessions: [
                    { id: 'session-a', workbenchProjectId: 'project-p' },
                    { id: 'session-b', workbenchProjectId: 'project-p' },
                ],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'files.changed',
            payload: {
                sessionId: 'session-b',
                workbenchProjectId: 'project-p',
                overflow: false,
                changes: [{ path: '/project/src/index.ts', kind: 'update' }],
            },
        });
        vi.advanceTimersByTime(150);

        expect(queryClient.getQueryState(sharedListing)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(otherProjectListing)?.isInvalidated).toBe(false);
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
                    contextKey: 'project-p',
                },
            ],
            [],
        );
        queryClient.setQueryData(
            ['files.list', { sessionId: 'session-a', directory: '/project/src' }],
            { entries: [], truncated: false },
        );
        queryClient.setQueryData(
            ['files.list', { sessionId: 'session-a', directory: '/project/docs' }],
            { entries: [], truncated: false },
        );
        queryClient.setQueryData(
            [
                'viewContainers.viewOperation',
                {
                    viewId: filesView,
                    operation: 'files.list',
                    arguments: { directory: '/project/docs' },
                    contextKey: 'project-p',
                },
            ],
            [],
        );
        // The Project search overlay is not a controlled view: it caches under its own flat key, and a file change has
        // to reach it there or an open search keeps listing hits at paths that no longer contain them.
        queryClient.setQueryData(
            projectSearchQueryKey('session-a:project-p', { mode: 'name', query: 'x' }),
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
                    contextKey: 'project-p',
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
                    contextKey: 'project-p',
                },
            ])?.isInvalidated,
        ).toBe(false);
        expect(
            queryClient.getQueryState([
                'files.list',
                { sessionId: 'session-a', directory: '/project/src' },
            ])?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState([
                'files.list',
                { sessionId: 'session-a', directory: '/project/docs' },
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
            queryClient.getQueryState(
                projectSearchQueryKey('session-a:project-p', { mode: 'name', query: 'x' }),
            )?.isInvalidated,
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

    it('invalidates only the refreshed Session Project Status summary and overview queries', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['projectStatus.summary', { sessionId: 'session-a' }], {});
        queryClient.setQueryData(
            ['projectStatus.summary', { sessionId: 'session-a', refreshToken: 'refresh-1' }],
            {},
        );
        queryClient.setQueryData(['projectStatus.summary', { sessionId: 'session-b' }], {});
        queryClient.setQueryData(['projectStatus.overview', { sessionId: 'session-a' }], {});
        queryClient.setQueryData(['projectStatus.overview', { sessionId: 'session-b' }], {});
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
        // The status bar's `projectStatus.overview` read converges in the same event, instead of waiting out its own
        // poll (issue caxri#1310).
        expect(
            queryClient.getQueryState(['projectStatus.overview', { sessionId: 'session-a' }])
                ?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['projectStatus.overview', { sessionId: 'session-b' }])
                ?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    /**
     * `session.pullRequests` (the sidebar row) and `projectStatus.overview` (the status bar) both resolve a Session's
     * pull request through `SessionPullRequestService`/`ProjectStatusService`'s shared `GitHubPullRequestStore`, so a
     * `sessionPullRequests.changed` sweep must invalidate both instead of leaving the status bar on its own poll (issue
     * caxri#1310).
     */
    it('invalidates the shared pull-request query and only the affected Sessions’ overview reads', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['session.pullRequests', undefined], {});
        queryClient.setQueryData(['projectStatus.overview', { sessionId: 'session-a' }], {});
        queryClient.setQueryData(['projectStatus.overview', { sessionId: 'session-b' }], {});
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        mocks.state.handler?.({
            event: 'sessionPullRequests.changed',
            payload: { sessionIds: ['session-a'] },
        });

        expect(queryClient.getQueryState(['session.pullRequests', undefined])?.isInvalidated).toBe(
            true,
        );
        expect(
            queryClient.getQueryState(['projectStatus.overview', { sessionId: 'session-a' }])
                ?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(['projectStatus.overview', { sessionId: 'session-b' }])
                ?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });
});
