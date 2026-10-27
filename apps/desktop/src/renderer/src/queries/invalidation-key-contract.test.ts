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
import type { ExtensionTreeScope } from '../features/view-containers/extension-tree-client';
import { cacheTreeChildren } from '../features/view-containers/extension-tree-client';
import { controlledViewQueryKey } from '../features/view-containers/view-operation-client';
import { useWorkbenchStore } from '../stores/workbench';
import { caxriQueryKey } from './client';
import { removeSessionQueries, subscribeRuntimeQueryInvalidation } from './invalidation';

/**
 * Every key here is produced by the same factory production code uses: `caxriQueryKey`, `controlledViewQueryKey`, or
 * `cacheTreeChildren`'s private key builder. That is the whole point of the file: the invalidation predicates match
 * query keys by hand, so a key-shape change that the construction side absorbs silently would otherwise leave a
 * predicate matching nothing. A hand-written literal fixture cannot catch that, because it drifts in exactly the same
 * direction as the predicate.
 */
const SESSION_ID = 'session-a';
const PROJECT_ID = 'project-p';
const VIEW_ID = 'caxri.resourceExplorer';
const CONTEXT_KEY = `${SESSION_ID}:${PROJECT_ID}`;
const TREE_SCOPE: ExtensionTreeScope = {
    extensionGeneration: 1,
    sessionId: SESSION_ID,
    viewId: 'ext.tree',
    workbenchProjectId: PROJECT_ID,
};

afterEach(() => {
    vi.useRealTimers();
    useWorkbenchStore.setState({ bootstrap: undefined });
});

function seedWorkbench(): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: SESSION_ID,
            sessions: [{ id: SESSION_ID, workbenchProjectId: PROJECT_ID }],
            sessionStates: [],
            terminals: [],
        } as unknown as BootstrapState,
    });
}

/**
 * Delivers one Server event to a live subscription. `settleMs` runs the fake-timer clock before unsubscribing:
 * `files.changed` invalidation is debounced, and unsubscribing clears the pending timer, so that path has to settle
 * while the subscription is still live.
 */
function emit(queryClient: QueryClient, event: ServerEvent, settleMs?: number): void {
    seedWorkbench();
    const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);
    mocks.state.handler?.(event);
    if (settleMs !== undefined) vi.advanceTimersByTime(settleMs);
    unsubscribe();
}

function isInvalidated(queryClient: QueryClient, queryKey: readonly unknown[]): boolean {
    return queryClient.getQueryState(queryKey)?.isInvalidated === true;
}

describe('invalidation predicates match factory-built query keys', () => {
    it('invalidates the direct and controlled Files listings a files.changed event covers', () => {
        vi.useFakeTimers();
        const queryClient = new QueryClient();
        const directListing = caxriQueryKey('files.list', {
            sessionId: SESSION_ID,
            directory: '/project-p/src',
        });
        const controlledListing = controlledViewQueryKey(
            VIEW_ID,
            'files.list',
            { directory: '/project-p/src' },
            CONTEXT_KEY,
        );
        queryClient.setQueryData(directListing, { entries: [] });
        queryClient.setQueryData(controlledListing, { entries: [] });

        emit(
            queryClient,
            {
                event: 'files.changed',
                payload: {
                    sessionId: SESSION_ID,
                    workbenchProjectId: PROJECT_ID,
                    overflow: false,
                    changes: [{ path: '/project-p/src/file.ts', kind: 'update' }],
                },
            },
            150,
        );

        expect(isInvalidated(queryClient, directListing)).toBe(true);
        expect(isInvalidated(queryClient, controlledListing)).toBe(true);
    });

    it.each([
        'git.summary',
        'git.overview',
        'git.diffDocument',
        'git.blame',
        'git.fileHead',
    ] as const)('invalidates the %s read a git.changed event covers', (method) => {
        const queryClient = new QueryClient();
        const key = caxriQueryKey(method, { sessionId: SESSION_ID });
        queryClient.setQueryData(key, {});

        emit(queryClient, {
            event: 'git.changed',
            payload: { sessionIds: [SESSION_ID] },
        } as ServerEvent);

        expect(isInvalidated(queryClient, key)).toBe(true);
    });

    it('invalidates the Project Status summary and overview reads its own change event names', () => {
        const queryClient = new QueryClient();
        const summary = caxriQueryKey('projectStatus.summary', { sessionId: SESSION_ID });
        const overview = caxriQueryKey('projectStatus.overview', { sessionId: SESSION_ID });
        queryClient.setQueryData(summary, {});
        queryClient.setQueryData(overview, {});

        emit(queryClient, {
            event: 'projectStatus.changed',
            payload: { sessionId: SESSION_ID },
        });

        expect(isInvalidated(queryClient, summary)).toBe(true);
        // The status bar's overview converges in the same event as the Status panel (issue caxri#1310).
        expect(isInvalidated(queryClient, overview)).toBe(true);
    });

    it('invalidates the shared pull-request read and the affected Session’s overview read a sessionPullRequests.changed event covers', () => {
        const queryClient = new QueryClient();
        const pullRequests = caxriQueryKey('session.pullRequests', undefined as never);
        const overview = caxriQueryKey('projectStatus.overview', { sessionId: SESSION_ID });
        queryClient.setQueryData(pullRequests, {});
        queryClient.setQueryData(overview, {});

        emit(queryClient, {
            event: 'sessionPullRequests.changed',
            payload: { sessionIds: [SESSION_ID] },
        });

        expect(isInvalidated(queryClient, pullRequests)).toBe(true);
        expect(isInvalidated(queryClient, overview)).toBe(true);
    });

    it('invalidates the Bot Inbox read behind the status bar chip on botInbox.changed', () => {
        const queryClient = new QueryClient();
        const inbox = caxriQueryKey('bot.inbox.list', {});
        queryClient.setQueryData(inbox, { generatedAt: 0, items: [] });

        emit(queryClient, { event: 'botInbox.changed', payload: { itemIds: ['item-a'] } });

        expect(isInvalidated(queryClient, inbox)).toBe(true);
    });

    it('invalidates the "Always allow in this Session" read its own change event names (issue caxri#1295)', () => {
        const queryClient = new QueryClient();
        const status = caxriQueryKey('session.permissionAutoAllowStatus', {
            sessionId: SESSION_ID,
        });
        queryClient.setQueryData(status, { granted: false });

        emit(queryClient, {
            event: 'agent.permissionAutoAllowChanged',
            payload: { sessionId: SESSION_ID, granted: true, grantedAt: 1_700 },
        });

        expect(isInvalidated(queryClient, status)).toBe(true);
    });

    it('invalidates the review comment list and pending summary a gitReview.changed event covers (issue caxri#1294)', () => {
        const queryClient = new QueryClient();
        const list = caxriQueryKey('gitReview.list', {
            sessionId: SESSION_ID,
            repositoryId: 'repo-1',
        });
        const otherRepoList = caxriQueryKey('gitReview.list', {
            sessionId: SESSION_ID,
            repositoryId: 'repo-2',
        });
        const pending = caxriQueryKey('gitReview.pending', {});
        for (const key of [list, otherRepoList, pending]) queryClient.setQueryData(key, {});

        emit(queryClient, {
            event: 'gitReview.changed',
            payload: { sessionId: SESSION_ID, repositoryId: 'repo-1' },
        });

        expect(isInvalidated(queryClient, list)).toBe(true);
        expect(isInvalidated(queryClient, pending)).toBe(true);
        // A different repository's list is untouched: `gitReview.changed` is scoped to the repository that changed.
        expect(isInvalidated(queryClient, otherRepoList)).toBe(false);
    });

    it('invalidates the delivery reads and every Files tree after a valid settings write', () => {
        const queryClient = new QueryClient();
        const summary = caxriQueryKey('projectStatus.summary', { sessionId: SESSION_ID });
        const pullRequests = caxriQueryKey('session.pullRequests', undefined as never);
        const directListing = caxriQueryKey('files.list', { sessionId: SESSION_ID });
        // The overlay's own flat key, not a controlled-view one: Project search left the Files view container.
        const overlaySearch = projectSearchQueryKey(CONTEXT_KEY, { query: 'todo' });
        for (const key of [summary, pullRequests, directListing, overlaySearch])
            queryClient.setQueryData(key, {});

        emit(queryClient, {
            event: 'settings.changed',
            payload: { source: 'user' },
        });

        expect(isInvalidated(queryClient, summary)).toBe(true);
        expect(isInvalidated(queryClient, pullRequests)).toBe(true);
        expect(isInvalidated(queryClient, directListing)).toBe(true);
        expect(isInvalidated(queryClient, overlaySearch)).toBe(true);
    });

    it('invalidates the Agent transcript read its change event names', () => {
        const queryClient = new QueryClient();
        const transcript = caxriQueryKey('terminal.agentTranscript', {
            terminalId: 'terminal-1',
        });
        queryClient.setQueryData(transcript, {});

        emit(queryClient, {
            event: 'agentTranscript.changed',
            payload: { terminalId: 'terminal-1' },
        });

        expect(isInvalidated(queryClient, transcript)).toBe(true);
    });

    it('invalidates the scoped Source Control read a view content change names', () => {
        const queryClient = new QueryClient();
        const snapshot = controlledViewQueryKey(
            VIEW_ID,
            'source.snapshot',
            { refresh: 0 },
            CONTEXT_KEY,
        );
        queryClient.setQueryData(snapshot, {});

        emit(queryClient, {
            event: 'viewContainers.viewChanged',
            payload: {
                viewId: VIEW_ID,
                change: { kind: 'content' },
                context: {
                    kind: 'session',
                    sessionId: SESSION_ID,
                    workbenchProjectId: PROJECT_ID,
                },
            },
        } as ServerEvent);

        expect(isInvalidated(queryClient, snapshot)).toBe(true);
    });

    it('refreshes the catalog and controlled reads and drops tree branches on a catalog change', () => {
        const queryClient = new QueryClient();
        const catalog = caxriQueryKey('viewContainers.catalog', undefined as never);
        const controlled = controlledViewQueryKey(VIEW_ID, 'badge.snapshot', {}, CONTEXT_KEY);
        queryClient.setQueryData(catalog, {});
        queryClient.setQueryData(controlled, {});
        cacheTreeChildren(queryClient, TREE_SCOPE, 'root', []);
        expect(queryClient.getQueryCache().getAll()).toHaveLength(3);

        emit(queryClient, { event: 'viewContainers.catalogChanged', payload: {} } as ServerEvent);

        expect(isInvalidated(queryClient, catalog)).toBe(true);
        expect(isInvalidated(queryClient, controlled)).toBe(true);
        // Retired provider handles are dropped, not invalidated, so the branch must be gone entirely.
        expect(queryClient.getQueryCache().getAll()).toHaveLength(2);
    });

    it('sweeps a deleted Session out of a branch written through the tree cache', () => {
        const queryClient = new QueryClient();
        cacheTreeChildren(queryClient, TREE_SCOPE, 'root', []);
        expect(queryClient.getQueryCache().getAll()).toHaveLength(1);

        removeSessionQueries(queryClient, [SESSION_ID]);

        expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    });
});
