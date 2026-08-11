import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BootstrapState, FileMutationOperation } from '@shared/types';

const mocks = vi.hoisted(() => ({
    request: vi.fn((method?: unknown): Promise<unknown> => {
        void method;
        return Promise.resolve(null);
    }),
}));

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { caxriQueryKey, queryClient } from '../../../../queries/client';
import { useSessionViewStore } from '../../../../stores/session-view';
import { dismissToast, useToastStore } from '../../../../stores/toasts';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { reconcileFileMutation } from './file-operation-reconciliation';
import { useFileOperationStore } from './file-operation-state';

beforeEach(() => vi.stubGlobal('window', globalThis));

afterEach(() => {
    vi.useRealTimers();
    mocks.request.mockClear();
    queryClient.clear();
    useFileOperationStore.getState().clear();
    useSessionViewStore.setState({ activeWork: {}, documents: {}, recentDocuments: {} });
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    dismissToast();
    vi.unstubAllGlobals();
});

describe('file mutation reconciliation', () => {
    it('applies a late move before acknowledging it and leaves no stale editor path', async () => {
        const sessionStateSaved = Promise.withResolvers<unknown>();
        mocks.request.mockImplementation((method) =>
            method === 'session.updateState' ? sessionStateSaved.promise : Promise.resolve(null),
        );
        const previousPath = '/project/source.txt';
        const nextPath = '/project/destination/source.txt';
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [
                    { id: 'session-a', projectId: 'project-1' },
                    { id: 'session-b', projectId: 'project-1' },
                ],
                sessionStates: ['session-a', 'session-b'].map((sessionId) => ({
                    sessionId,
                    openTabs: [{ path: previousPath, dirty: true }],
                    activeTab: { kind: 'editor' as const, path: previousPath },
                    inspectorMode: 'files' as const,
                    layout: {},
                })),
                terminals: [],
            } as unknown as BootstrapState,
        });
        for (const sessionId of ['session-a', 'session-b']) {
            useSessionViewStore.getState().cacheDocument(sessionId, {
                path: previousPath,
                content: `${sessionId} unsaved`,
                dirty: true,
                mtimeMs: 1,
                size: 17,
            });
            queryClient.setQueryData(
                caxriQueryKey('files.list', { sessionId, directory: '/project' }),
                [],
            );
            queryClient.setQueryData(
                caxriQueryKey('files.list', {
                    sessionId,
                    directory: '/project/destination',
                }),
                [],
            );
        }
        const operation: FileMutationOperation = {
            id: 'operation-late-move',
            kind: 'move',
            sessionId: 'session-a',
            phase: 'completed',
            input: {
                path: previousPath,
                directory: '/project/destination',
                conflict: 'reject',
            },
            expectedResult: {
                device: '1',
                inode: '2',
                kind: 'file',
                name: 'source.txt',
                path: nextPath,
                previousPath,
            },
            result: {
                kind: 'file',
                name: 'source.txt',
                path: nextPath,
                previousPath,
            },
            startedAt: 1,
            updatedAt: 2,
        };

        const reconciliation = reconcileFileMutation(operation);
        await vi.waitFor(() => {
            expect(
                mocks.request.mock.calls.filter(([method]) => method === 'session.updateState'),
            ).toHaveLength(2);
        });
        const beforeSessionStateSave = await Promise.race([
            reconciliation.then(() => 'reconciled' as const),
            new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 0)),
        ]);
        expect(beforeSessionStateSave).toBe('waiting');
        expect(mocks.request).not.toHaveBeenCalledWith('files.operation.acknowledge', {
            operationId: operation.id,
        });
        sessionStateSaved.resolve(null);
        await reconciliation;

        expect(
            useWorkbenchStore.getState().bootstrap?.sessionStates.map((state) => state.openTabs),
        ).toEqual([[{ path: nextPath, dirty: true }], [{ path: nextPath, dirty: true }]]);
        expect(
            Object.values(useSessionViewStore.getState().documents).flatMap((documents) =>
                Object.keys(documents),
            ),
        ).toEqual([nextPath, nextPath]);
        expect(
            queryClient.getQueryState(
                caxriQueryKey('files.list', {
                    sessionId: 'session-b',
                    directory: '/project/destination',
                }),
            )?.isInvalidated,
        ).toBe(true);
        expect(mocks.request).toHaveBeenLastCalledWith('files.operation.acknowledge', {
            operationId: operation.id,
        });
        expect(useFileOperationStore.getState().operations).toEqual([]);
        expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({ kind: 'success', message: 'Item moved' }),
        );
    });

    it('retries a completed move after one Session-state persistence failure', async () => {
        vi.useFakeTimers();
        let sessionStateWrites = 0;
        mocks.request.mockImplementation((method) => {
            if (method !== 'session.updateState') return Promise.resolve(null);
            sessionStateWrites += 1;
            return sessionStateWrites === 2
                ? Promise.reject(new Error('temporary database failure'))
                : Promise.resolve(null);
        });
        const previousPath = '/project/source.txt';
        const nextPath = '/project/destination/source.txt';
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [
                    { id: 'session-a', projectId: 'project-1' },
                    { id: 'session-b', projectId: 'project-1' },
                ],
                sessionStates: ['session-a', 'session-b'].map((sessionId) => ({
                    sessionId,
                    openTabs: [{ path: previousPath, dirty: true }],
                    activeTab: { kind: 'editor' as const, path: previousPath },
                    inspectorMode: 'files' as const,
                    layout: {},
                })),
                terminals: [],
            } as unknown as BootstrapState,
        });
        for (const sessionId of ['session-a', 'session-b']) {
            useSessionViewStore.getState().cacheDocument(sessionId, {
                path: previousPath,
                content: `${sessionId} dirty body`,
                dirty: true,
                mtimeMs: 1,
                size: 20,
            });
            useSessionViewStore
                .getState()
                .setActiveWork(sessionId, { kind: 'editor', path: previousPath });
        }
        const operation: FileMutationOperation = {
            id: 'operation-retry-move',
            kind: 'move',
            sessionId: 'session-a',
            phase: 'completed',
            input: {
                path: previousPath,
                directory: '/project/destination',
                conflict: 'reject',
            },
            expectedResult: {
                device: '1',
                inode: '2',
                kind: 'file',
                name: 'source.txt',
                path: nextPath,
                previousPath,
            },
            result: {
                kind: 'file',
                name: 'source.txt',
                path: nextPath,
                previousPath,
            },
            startedAt: 1,
            updatedAt: 2,
        };

        await expect(reconcileFileMutation(operation)).rejects.toThrow(
            'Moved editor state could not be saved',
        );
        expect(
            useWorkbenchStore.getState().bootstrap?.sessionStates.map((state) => state.openTabs),
        ).toEqual([[{ path: nextPath, dirty: true }], [{ path: nextPath, dirty: true }]]);
        expect(useSessionViewStore.getState().activeWork).toEqual({
            'session-a': { kind: 'editor', path: nextPath },
            'session-b': { kind: 'editor', path: nextPath },
        });
        expect(useSessionViewStore.getState().documents).toMatchObject({
            'session-a': {
                [nextPath]: { content: 'session-a dirty body', dirty: true, path: nextPath },
            },
            'session-b': {
                [nextPath]: { content: 'session-b dirty body', dirty: true, path: nextPath },
            },
        });

        await vi.runOnlyPendingTimersAsync();
        await vi.waitFor(() => {
            expect(mocks.request).toHaveBeenCalledWith('files.operation.acknowledge', {
                operationId: operation.id,
            });
        });
        expect(
            useWorkbenchStore.getState().bootstrap?.sessionStates.map((state) => state.openTabs),
        ).toEqual([[{ path: nextPath, dirty: true }], [{ path: nextPath, dirty: true }]]);
        expect(
            Object.values(useSessionViewStore.getState().documents).map((documents) =>
                Object.keys(documents),
            ),
        ).toEqual([[nextPath], [nextPath]]);
        expect(
            Object.values(useSessionViewStore.getState().documents).map(
                (documents) => documents[nextPath]?.content,
            ),
        ).toEqual(['session-a dirty body', 'session-b dirty body']);
    });
});
