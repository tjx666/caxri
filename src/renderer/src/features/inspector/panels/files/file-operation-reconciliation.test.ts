import type { BootstrapState, FileMutationOperation } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
}));

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { caxriQueryKey, queryClient } from '../../../../queries/client';
import { getSessionDocuments, useSessionViewStore } from '../../../../stores/session-view';
import { dismissToast, useToastStore } from '../../../../stores/toasts';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { reconcileFileMutation } from './file-operation-reconciliation';
import { useFileOperationStore } from './file-operation-state';

function session(id: string, workbenchProjectId = 'project-1', projectId = 'project-1') {
    return { id, projectId, workbenchProjectId };
}

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
    it('reconciles a completed move against its originating Workbench Root', async () => {
        const ownerProjectId = 'project-owner';
        const operationProjectId = 'project-a';
        const currentProjectId = 'project-b';
        const previousPath = '/project-a/source.txt';
        const nextPath = '/project-a/destination/source.txt';
        const currentPath = '/project-b/source.txt';
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', currentProjectId, ownerProjectId)],
                sessionStates: [
                    {
                        sessionId: 'session-a',
                        workbenchProjectId: currentProjectId,
                        openTabs: [{ path: currentPath, dirty: true }],
                        activeTab: { kind: 'editor' as const, path: currentPath },
                        inspectorMode: 'files' as const,
                        layout: {},
                    },
                ],
                terminals: [],
            } as unknown as BootstrapState,
        });
        useSessionViewStore.getState().cacheDocument(
            'session-a',
            {
                path: previousPath,
                content: 'root A draft',
                dirty: true,
                mtimeMs: 1,
                size: 12,
            },
            operationProjectId,
        );
        useSessionViewStore.getState().cacheDocument(
            'session-a',
            {
                path: currentPath,
                content: 'root B draft',
                dirty: true,
                mtimeMs: 1,
                size: 12,
            },
            currentProjectId,
        );
        const operation = {
            id: 'operation-root-a-move',
            kind: 'move',
            sessionId: 'session-a',
            workbenchProjectId: operationProjectId,
            phase: 'completed',
            input: {
                path: previousPath,
                directory: '/project-a/destination',
                conflict: 'reject',
            },
            result: {
                kind: 'file',
                name: 'source.txt',
                path: nextPath,
                previousPath,
            },
            startedAt: 1,
            updatedAt: 2,
        } as FileMutationOperation & { workbenchProjectId: string };

        await reconcileFileMutation(operation);

        expect(getSessionDocuments('session-a', operationProjectId)?.[nextPath]).toMatchObject({
            content: 'root A draft',
            dirty: true,
        });
        expect(
            getSessionDocuments('session-a', operationProjectId)?.[previousPath],
        ).toBeUndefined();
        expect(getSessionDocuments('session-a', currentProjectId)?.[currentPath]).toMatchObject({
            content: 'root B draft',
            dirty: true,
        });
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0]).toMatchObject({
            workbenchProjectId: currentProjectId,
            openTabs: [{ path: currentPath, dirty: true }],
            activeTab: { kind: 'editor', path: currentPath },
        });
        expect(mocks.request).not.toHaveBeenCalledWith('session.updateState', expect.anything());
        expect(mocks.request).toHaveBeenCalledWith('files.operation.acknowledge', {
            operationId: operation.id,
        });
    });

    it('applies a late move before acknowledging it and leaves no stale editor path', async () => {
        const sessionStateSaved = Promise.withResolvers<unknown>();
        mocks.request.mockImplementation((method) =>
            method === 'session.updateState' ? sessionStateSaved.promise : Promise.resolve(null),
        );
        const previousPath = '/project/source.txt';
        const nextPath = '/project/destination/source.txt';
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a'), session('session-b')],
                sessionStates: ['session-a', 'session-b'].map((sessionId) => ({
                    sessionId,
                    workbenchProjectId: 'project-1',
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
        const awaitReconciliation = async (): Promise<'reconciled'> => {
            await reconciliation;
            return 'reconciled';
        };
        const beforeSessionStateSave = await Promise.race([
            awaitReconciliation(),
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
            expect.objectContaining({ kind: 'success', message: "'source.txt' moved" }),
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
                sessions: [session('session-a'), session('session-b')],
                sessionStates: ['session-a', 'session-b'].map((sessionId) => ({
                    sessionId,
                    workbenchProjectId: 'project-1',
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

        await expect(reconcileFileMutation(operation)).resolves.toBeUndefined();
        expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({
                kind: 'info',
                message: 'File change is still synchronizing in the background',
            }),
        );
        expect(useToastStore.getState().toasts).not.toContainEqual(
            expect.objectContaining({ kind: 'error' }),
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

        const sessionB = useWorkbenchStore
            .getState()
            .bootstrap?.sessionStates.find((state) => state.sessionId === 'session-b');
        expect(sessionB).toBeDefined();
        useSessionViewStore.getState().cacheDocument('session-b', {
            path: previousPath,
            content: 'new source body',
            dirty: true,
            mtimeMs: 2,
            size: 15,
        });
        useSessionViewStore
            .getState()
            .setActiveWork('session-b', { kind: 'editor', path: previousPath });
        await expect(
            useWorkbenchStore.getState().patchSessionState({
                ...sessionB!,
                openTabs: [...sessionB!.openTabs, { path: previousPath, dirty: true }],
                activeTab: { kind: 'editor', path: previousPath },
            }),
        ).resolves.toBe(true);

        await vi.runOnlyPendingTimersAsync();
        await vi.waitFor(() => {
            expect(mocks.request).toHaveBeenCalledWith('files.operation.acknowledge', {
                operationId: operation.id,
            });
        });
        expect(
            useWorkbenchStore.getState().bootstrap?.sessionStates.map((state) => state.openTabs),
        ).toEqual([
            [{ path: nextPath, dirty: true }],
            [
                { path: nextPath, dirty: true },
                { path: previousPath, dirty: true },
            ],
        ]);
        expect(useSessionViewStore.getState().activeWork).toEqual({
            'session-a': { kind: 'editor', path: nextPath },
            'session-b': { kind: 'editor', path: previousPath },
        });
        expect(useSessionViewStore.getState().documents).toMatchObject({
            'session-a': {
                [nextPath]: { content: 'session-a dirty body', dirty: true, path: nextPath },
            },
            'session-b': {
                [nextPath]: { content: 'session-b dirty body', dirty: true, path: nextPath },
                [previousPath]: { content: 'new source body', dirty: true, path: previousPath },
            },
        });
        expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({ kind: 'success', message: "'source.txt' moved" }),
        );
        expect(useToastStore.getState().toasts).not.toContainEqual(
            expect.objectContaining({ kind: 'error' }),
        );
    });

    it('does not replay a remap whose durable checkpoint survived Renderer reload', async () => {
        const operationId = 'operation-reloaded-move';
        const previousPath = '/project/source.txt';
        const nextPath = '/project/destination/source.txt';
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a')],
                sessionStates: [
                    {
                        sessionId: 'session-a',
                        workbenchProjectId: 'project-1',
                        openTabs: [
                            { path: nextPath, dirty: false },
                            { path: previousPath, dirty: false },
                        ],
                        activeTab: { kind: 'editor', path: previousPath },
                        inspectorMode: 'files',
                        layout: {},
                        editorRemapOperationId: operationId,
                    },
                ],
                terminals: [],
            } as unknown as BootstrapState,
        });
        useSessionViewStore.getState().cacheDocument('session-a', {
            path: nextPath,
            content: 'moved body',
            dirty: false,
            mtimeMs: 1,
            size: 10,
        });
        useSessionViewStore.getState().cacheDocument('session-a', {
            path: previousPath,
            content: 'new source body',
            dirty: false,
            mtimeMs: 2,
            size: 15,
        });
        useSessionViewStore
            .getState()
            .setActiveWork('session-a', { kind: 'editor', path: previousPath });

        await reconcileFileMutation({
            id: operationId,
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
        });

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0]?.openTabs).toEqual([
            { path: nextPath, dirty: false },
            { path: previousPath, dirty: false },
        ]);
        expect(useSessionViewStore.getState().activeWork['session-a']).toEqual({
            kind: 'editor',
            path: previousPath,
        });
        expect(useSessionViewStore.getState().documents['session-a']).toMatchObject({
            [nextPath]: { content: 'moved body', path: nextPath },
            [previousPath]: { content: 'new source body', path: previousPath },
        });
    });

    it('does not report success until the durable operation acknowledgement succeeds', async () => {
        vi.useFakeTimers();
        let acknowledgeAttempts = 0;
        mocks.request.mockImplementation((method) => {
            if (method === 'files.operation.acknowledge') {
                acknowledgeAttempts += 1;
                return acknowledgeAttempts === 1
                    ? Promise.reject(new Error('temporary journal failure'))
                    : Promise.resolve(null);
            }
            return Promise.resolve(null);
        });
        const previousPath = '/project/source.txt';
        const nextPath = '/project/destination/source.txt';
        const operation: FileMutationOperation = {
            id: 'operation-ack-retry',
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
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a')],
                sessionStates: [
                    {
                        sessionId: 'session-a',
                        workbenchProjectId: 'project-1',
                        openTabs: [],
                        inspectorMode: 'files',
                        layout: {},
                    },
                ],
                terminals: [],
            } as unknown as BootstrapState,
        });

        await reconcileFileMutation(operation);

        expect(useToastStore.getState().toasts).not.toContainEqual(
            expect.objectContaining({ kind: 'success' }),
        );
        expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({
                kind: 'info',
                message: 'File change is still synchronizing in the background',
            }),
        );
        expect(useFileOperationStore.getState().operations).toHaveLength(1);

        await vi.runOnlyPendingTimersAsync();
        await vi.waitFor(() => expect(acknowledgeAttempts).toBe(2));

        expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({ kind: 'success', message: "'source.txt' moved" }),
        );
        expect(useFileOperationStore.getState().operations).toEqual([]);
    });
});
