import type { BootstrapState, FileMutationOperation, SessionState } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
}));

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { queryClient } from '../../../../queries/client';
import { getSessionDocuments, useSessionViewStore } from '../../../../stores/session-view';
import { dismissToast, getToasts } from '../../../../stores/toasts';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { controlledViewQueryKey } from '../../view-operation-client';
import { createReconciliationQueue, reconcileFileMutation } from '../file-operation-reconciliation';
import { useFileOperationStore } from '../file-operation-state';
import type { ResourceExplorerClient } from '../resource-explorer-client';

function session(id: string, workbenchRootProjectId = 'project-1', projectId = 'project-1') {
    return { id, projectId, workbenchRootProjectId };
}

/**
 * A single-pane layout holding one document tab per path; these tests only care that a move rewrites the tabs' paths,
 * not about the tree's shape.
 */
function paneLayout(paths: string[], activeIndex = 0): SessionState['paneLayout'] {
    return {
        root: {
            type: 'pane',
            id: 'pane-1',
            tabs: paths.map((path, index) => ({
                id: `tab-${index}`,
                resource: { kind: 'file', path },
            })),
            ...(paths.length > 0 && { activeTabId: `tab-${activeIndex}` }),
        },
        activePaneId: 'pane-1',
    };
}

function paneTabs(state: SessionState): Array<{ id: string; path: string }> {
    const pane = state.paneLayout.root;
    if (pane.type !== 'pane') throw new Error('Expected a single-pane layout');
    return pane.tabs.map((tab) => ({
        id: tab.id,
        path: tab.resource.kind === 'file' ? tab.resource.path : tab.resource.terminalId,
    }));
}

function paneTabPaths(state: SessionState): string[] {
    return paneTabs(state).map((tab) => tab.path);
}

function activePaneTabPath(state: SessionState): string | undefined {
    const pane = state.paneLayout.root;
    if (pane.type !== 'pane') throw new Error('Expected a single-pane layout');
    return paneTabs(state).find((tab) => tab.id === pane.activeTabId)?.path;
}

function sessionStates(): SessionState[] {
    return useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
}

const client = {
    viewId: 'publisher.files.explorer',
    acknowledgeOperation: (operationId: string) =>
        mocks.request('files.operation.acknowledge', { operationId }),
} as unknown as ResourceExplorerClient;

beforeEach(() => vi.stubGlobal('window', globalThis));

afterEach(() => {
    vi.useRealTimers();
    mocks.request.mockClear();
    queryClient.clear();
    useFileOperationStore.getState().clear();
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    dismissToast();
    vi.unstubAllGlobals();
});

describe('file mutation reconciliation', () => {
    it('runs one queued recovery pass after a burst arrives during an in-flight pass', async () => {
        const firstPass = Promise.withResolvers<void>();
        let pass = 0;
        const run = vi.fn(() => {
            pass += 1;
            return pass === 1 ? firstPass.promise : Promise.resolve();
        });
        const queue = createReconciliationQueue(run);

        const first = queue.request();
        const queued = queue.request();
        expect(queued).toBe(first);
        expect(run).toHaveBeenCalledTimes(1);

        firstPass.resolve();
        await first;
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        queue.dispose();
    });

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
                        workbenchRootProjectId: currentProjectId,
                        desiredSecondarySidebarViewContainerId: 'caxri.files' as const,
                        paneLayout: paneLayout([currentPath]),
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
            workbenchRootProjectId: operationProjectId,
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
        } as FileMutationOperation & { workbenchRootProjectId: string };

        await reconcileFileMutation(client, operation);

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
        expect(sessionStates()[0]?.workbenchRootProjectId).toBe(currentProjectId);
        expect(paneTabPaths(sessionStates()[0])).toEqual([currentPath]);
        expect(activePaneTabPath(sessionStates()[0])).toBe(currentPath);
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
                    workbenchRootProjectId: 'project-1',
                    desiredSecondarySidebarViewContainerId: 'caxri.files' as const,
                    paneLayout: paneLayout([previousPath]),
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
        }
        queryClient.setQueryData(
            controlledViewQueryKey(client.viewId, 'files.list', { directory: '/project' }),
            [],
        );
        queryClient.setQueryData(
            controlledViewQueryKey(client.viewId, 'files.list', {
                directory: '/project/destination',
            }),
            [],
        );
        const operation: FileMutationOperation = {
            id: 'operation-late-move',
            kind: 'move',
            sessionId: 'session-a',
            workbenchRootProjectId: 'project-1',
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

        const reconciliation = reconcileFileMutation(client, operation);
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

        expect(sessionStates().map((state) => paneTabPaths(state))).toEqual([
            [nextPath],
            [nextPath],
        ]);
        expect(
            Object.values(useSessionViewStore.getState().documents).flatMap((documents) =>
                Object.keys(documents),
            ),
        ).toEqual([nextPath, nextPath]);
        expect(
            queryClient.getQueryState(
                controlledViewQueryKey(client.viewId, 'files.list', {
                    directory: '/project/destination',
                }),
            )?.isInvalidated,
        ).toBe(true);
        expect(mocks.request).toHaveBeenLastCalledWith('files.operation.acknowledge', {
            operationId: operation.id,
        });
        expect(useFileOperationStore.getState().operations).toEqual([]);
        expect(getToasts()).toContainEqual(
            expect.objectContaining({ type: 'success', title: "'source.txt' moved" }),
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
                    workbenchRootProjectId: 'project-1',
                    desiredSecondarySidebarViewContainerId: 'caxri.files' as const,
                    paneLayout: paneLayout([previousPath]),
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
        }
        const operation: FileMutationOperation = {
            id: 'operation-retry-move',
            kind: 'move',
            sessionId: 'session-a',
            workbenchRootProjectId: 'project-1',
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

        await expect(reconcileFileMutation(client, operation)).resolves.toBeUndefined();
        expect(getToasts()).toContainEqual(
            expect.objectContaining({
                type: 'info',
                title: 'File change is still synchronizing in the background',
            }),
        );
        expect(getToasts()).not.toContainEqual(expect.objectContaining({ type: 'error' }));
        expect(sessionStates().map((state) => paneTabPaths(state))).toEqual([
            [nextPath],
            [nextPath],
        ]);
        expect(sessionStates().map((state) => activePaneTabPath(state))).toEqual([
            nextPath,
            nextPath,
        ]);
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
        await expect(
            useWorkbenchStore.getState().patchSessionState({
                ...sessionB!,
                paneLayout: paneLayout([nextPath, previousPath], 1),
            }),
        ).resolves.toBe(true);

        await vi.runOnlyPendingTimersAsync();
        await vi.waitFor(() => {
            expect(mocks.request).toHaveBeenCalledWith('files.operation.acknowledge', {
                operationId: operation.id,
            });
        });
        expect(sessionStates().map((state) => paneTabPaths(state))).toEqual([
            [nextPath],
            [nextPath, previousPath],
        ]);
        expect(sessionStates().map((state) => activePaneTabPath(state))).toEqual([
            nextPath,
            previousPath,
        ]);
        expect(useSessionViewStore.getState().documents).toMatchObject({
            'session-a': {
                [nextPath]: { content: 'session-a dirty body', dirty: true, path: nextPath },
            },
            'session-b': {
                [nextPath]: { content: 'session-b dirty body', dirty: true, path: nextPath },
                [previousPath]: { content: 'new source body', dirty: true, path: previousPath },
            },
        });
        expect(getToasts()).toContainEqual(
            expect.objectContaining({ type: 'success', title: "'source.txt' moved" }),
        );
        expect(getToasts()).not.toContainEqual(expect.objectContaining({ type: 'error' }));
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
                        workbenchRootProjectId: 'project-1',
                        desiredSecondarySidebarViewContainerId: 'caxri.files',
                        paneLayout: paneLayout([nextPath, previousPath], 1),
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

        await reconcileFileMutation(client, {
            id: operationId,
            kind: 'move',
            sessionId: 'session-a',
            workbenchRootProjectId: 'project-1',
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

        expect(paneTabPaths(sessionStates()[0])).toEqual([nextPath, previousPath]);
        expect(activePaneTabPath(sessionStates()[0])).toBe(previousPath);
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
            workbenchRootProjectId: 'project-1',
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
                        workbenchRootProjectId: 'project-1',
                        desiredSecondarySidebarViewContainerId: 'caxri.files',
                        paneLayout: paneLayout([]),
                    },
                ],
                terminals: [],
            } as unknown as BootstrapState,
        });

        await reconcileFileMutation(client, operation);

        expect(getToasts()).not.toContainEqual(expect.objectContaining({ type: 'success' }));
        expect(getToasts()).toContainEqual(
            expect.objectContaining({
                type: 'info',
                title: 'File change is still synchronizing in the background',
            }),
        );
        expect(useFileOperationStore.getState().operations).toHaveLength(1);

        await vi.runOnlyPendingTimersAsync();
        await vi.waitFor(() => expect(acknowledgeAttempts).toBe(2));

        expect(getToasts()).toContainEqual(
            expect.objectContaining({ type: 'success', title: "'source.txt' moved" }),
        );
        expect(useFileOperationStore.getState().operations).toEqual([]);
    });
});
