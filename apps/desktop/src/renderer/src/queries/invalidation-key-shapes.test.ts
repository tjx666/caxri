import type { ServerEvent, TreeItemDto } from '@caxri/protocol';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

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

import type { ExtensionTreeScope } from '../features/view-containers/extension-tree-client';
import {
    cacheTreeChildren,
    readCachedTreeChildren,
    ROOT_HANDLE,
} from '../features/view-containers/extension-tree-client';
import { controlledViewQueryKey } from '../features/view-containers/view-operation-client';
import { caxriQueryKey } from './client';
import { subscribeRuntimeQueryInvalidation } from './invalidation';

/**
 * Every case here seeds the cache through the production key factory rather than a hand-written array, because a
 * hand-written key drifts alongside a broken predicate and keeps the test green. Two `viewContainers.treeChildren`
 * predicates matched nothing for a long time for exactly that reason (issue #799): the key shape they were written
 * against was gone, and nothing in the suite had ever produced a real one.
 */
const scope: ExtensionTreeScope = {
    extensionGeneration: 1,
    sessionId: 'session-a',
    viewId: 'publisher.tree',
    workbenchRootProjectId: 'project-1',
};

function branch(queryClient: QueryClient): void {
    cacheTreeChildren(queryClient, scope, ROOT_HANDLE, [
        { handle: 'child', label: 'child' } as TreeItemDto,
    ]);
}

function emit(event: ServerEvent): void {
    mocks.state.handler?.(event);
}

describe('runtime invalidation matches the production key factories', () => {
    it('drops Extension Tree branches the tree runtime actually cached', () => {
        const queryClient = new QueryClient();
        branch(queryClient);
        expect(readCachedTreeChildren(queryClient, scope).size).toBe(1);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        emit({ event: 'viewContainers.catalogChanged', payload: { revision: 2 } });

        expect(readCachedTreeChildren(queryClient, scope).size).toBe(0);
        unsubscribe();
    });

    it('drops Extension Tree branches after a reconnect that replaced the host', () => {
        const queryClient = new QueryClient();
        branch(queryClient);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        emit({
            event: 'host.connectionChanged',
            payload: { status: 'reconnected', downtimeMs: 10, attempt: 1, isHostReplaced: true },
        });

        expect(readCachedTreeChildren(queryClient, scope).size).toBe(0);
        unsubscribe();
    });

    it('invalidates a controlled-view read keyed by the real controlled-view factory', () => {
        const queryClient = new QueryClient();
        const key = controlledViewQueryKey(
            scope.viewId,
            'files.list',
            { directory: '/project' },
            scope.workbenchRootProjectId,
        );
        queryClient.setQueryData(key, []);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        emit({ event: 'viewContainers.catalogChanged', payload: { revision: 2 } });

        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
        unsubscribe();
    });

    it.each([
        ['badge', 'badge.snapshot'],
        ['content', 'source.snapshot'],
    ] as const)('invalidates the %s read a view change covers', (kind, operation) => {
        const queryClient = new QueryClient();
        const key = controlledViewQueryKey(
            scope.viewId,
            operation,
            {},
            `${scope.sessionId}:${scope.workbenchRootProjectId}`,
        );
        queryClient.setQueryData(key, {});
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        emit({
            event: 'viewContainers.viewChanged',
            payload: {
                viewId: scope.viewId,
                eventId: 'event-1',
                extensionGeneration: scope.extensionGeneration,
                context: {
                    kind: 'session',
                    sessionId: scope.sessionId,
                    workbenchRootProjectId: scope.workbenchRootProjectId,
                },
                change: { kind },
            },
        });

        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
        unsubscribe();
    });

    it('invalidates the plain method reads a settings write, Git change, and transcript push cover', () => {
        const queryClient = new QueryClient();
        const summary = caxriQueryKey('projectStatus.summary', { sessionId: scope.sessionId });
        const pullRequests = caxriQueryKey('session.pullRequests', undefined);
        const gitSummary = caxriQueryKey('git.summary', { sessionId: scope.sessionId });
        const transcript = caxriQueryKey('terminal.agentTranscript', { terminalId: 'terminal-a' });
        const agentActions = caxriQueryKey('agentActions.list', { terminalId: 'terminal-a' });
        const fileTree = controlledViewQueryKey(
            scope.viewId,
            'files.list',
            { directory: '/project' },
            scope.workbenchRootProjectId,
        );
        for (const key of [summary, pullRequests, gitSummary, transcript, agentActions, fileTree])
            queryClient.setQueryData(key, {});
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        emit({ event: 'settings.changed', payload: { source: '{}' } });
        emit({
            event: 'git.changed',
            payload: { sessionIds: [scope.sessionId], repositoryIds: [], scope: 'status' },
        });
        emit({ event: 'agentTranscript.changed', payload: { terminalId: 'terminal-a' } });

        expect(queryClient.getQueryState(summary)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(pullRequests)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(gitSummary)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(transcript)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(fileTree)?.isInvalidated).toBe(true);
        // Agent Action results embed provider settings, so a settings write drops them rather than refetching.
        expect(queryClient.getQueryData(agentActions)).toBeUndefined();
        unsubscribe();
    });

    it('invalidates the Files reads a debounced file change covers', () => {
        vi.useFakeTimers();
        const queryClient = new QueryClient();
        // `files.browse` is deliberately not seeded here: the Path Browser is owned by Desktop Main
        // (`main/path-browser-authority.ts`), which calls Server directly, so the Renderer never caches that method and
        // the predicate no longer names it.
        const list = caxriQueryKey('files.list', {
            sessionId: scope.sessionId,
            directory: '/project',
        });
        const controlled = controlledViewQueryKey(
            scope.viewId,
            'files.list',
            { directory: '/project' },
            scope.workbenchRootProjectId,
        );
        for (const key of [list, controlled]) queryClient.setQueryData(key, []);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        emit({
            event: 'files.changed',
            payload: {
                sessionId: scope.sessionId,
                workbenchRootProjectId: scope.workbenchRootProjectId,
                overflow: false,
                changes: [{ path: '/project/file.ts', kind: 'update' }],
            },
        });
        vi.advanceTimersByTime(150);

        expect(queryClient.getQueryState(list)?.isInvalidated).toBe(true);
        expect(queryClient.getQueryState(controlled)?.isInvalidated).toBe(true);
        unsubscribe();
        vi.useRealTimers();
    });
});
