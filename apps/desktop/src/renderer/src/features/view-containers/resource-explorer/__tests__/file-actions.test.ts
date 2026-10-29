import type { BootstrapState, FileMutationOperation } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(method: string, parameters: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { queryClient } from '../../../../queries/client';
import { useSessionViewStore } from '../../../../stores/session-view';
import { dismissToast, getToasts } from '../../../../stores/toasts';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { controlledViewQueryKey } from '../../view-operation-client';
import {
    createItem,
    didTrashFile,
    duplicateFile,
    moveFile,
    pasteFile,
    renameFile,
} from '../file-actions';
import { useFileClipboardStore } from '../file-clipboard';
import {
    resolveFileConflictChoice,
    useFileConflictDialogStore,
} from '../file-conflict-dialog-store';
import {
    failureToastSuppressionSizeForTests,
    reconcileFileMutation,
} from '../file-operation-reconciliation';
import { useFileOperationStore } from '../file-operation-state';
import type { ResourceExplorerClient } from '../resource-explorer-client';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    const { promise, resolve } = Promise.withResolvers<T>();
    return { promise, resolve };
}

/**
 * A `files.list` stub that reports one plain-file entry for any directory it is asked about.
 */
function fileEntryListing(name: string): unknown[] {
    return [{ name, path: `/anywhere/${name}`, kind: 'file' }];
}

function session(id: string, projectId: string, workbenchRootProjectId = projectId) {
    return { id, projectId, workbenchRootProjectId };
}

function paneLayout(path: string) {
    return {
        root: {
            type: 'pane',
            id: 'pane-1',
            tabs: [{ id: 'tab-1', resource: { kind: 'file', path } }],
            activeTabId: 'tab-1',
        },
        activePaneId: 'pane-1',
    };
}

/**
 * The `satisfies` clause is load-bearing. `mocks.request` answers `Promise<unknown>`, so the stub cannot be annotated
 * as a `ResourceExplorerClient` outright; but a bare `as` assertion reports nothing when a member is missing, and a
 * client method added later would then be `undefined` here while every call site silently took its failure path and the
 * tests stayed green (issue #909). Requiring every key restores that check without constraining the return types.
 */
const operationScope = { sessionId: 'session-a', workbenchRootProjectId: 'project-1' } as const;

const client = {
    viewId: 'publisher.files.explorer',
    acknowledgeOperation: (operationId: string) =>
        mocks.request('files.operation.acknowledge', { operationId }),
    cancelOperation: (operationId: string) =>
        mocks.request('files.operation.cancel', { operationId }),
    copy: (path: string, directory: string) =>
        mocks.request('files.copy', { sessionId: 'session-a', path, directory }),
    create: (options: Parameters<ResourceExplorerClient['create']>[0]) =>
        mocks.request('files.create', { sessionId: 'session-a', ...options }),
    forgetEditorPath: (workbenchRootProjectId: string, path: string) =>
        mocks.request('session.workbenchRoot.forgetEditorPath', {
            sessionId: 'session-a',
            workbenchRootProjectId,
            path,
        }),
    getOperation: (operationId: string) => mocks.request('files.operation.get', { operationId }),
    list: (directory?: string) =>
        mocks.request('files.list', { sessionId: 'session-a', directory }),
    listDirectory: (directory?: string) =>
        mocks.request('files.browse', { sessionId: 'session-a', directory }),
    listOperations: () => mocks.request('files.operation.list', {}),
    move: (options: Parameters<ResourceExplorerClient['move']>[0]) =>
        mocks.request('files.move', { sessionId: 'session-a', ...options }),
    rename: (options: Parameters<ResourceExplorerClient['rename']>[0]) =>
        mocks.request('files.rename', { sessionId: 'session-a', ...options }),
    restoreTrashed: vi.fn(),
    trash: (path: string, options?: Parameters<ResourceExplorerClient['trash']>[1]) =>
        mocks.request('files.trash', { sessionId: 'session-a', path, ...options }),
} satisfies Record<keyof ResourceExplorerClient, unknown> as unknown as ResourceExplorerClient;

beforeEach(() => vi.stubGlobal('window', globalThis));

afterEach(() => {
    mocks.request.mockReset();
    queryClient.clear();
    useFileOperationStore.getState().clear();
    useFileClipboardStore.setState({ entry: undefined });
    useFileConflictDialogStore.setState({ request: undefined, resolve: undefined });
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    dismissToast();
    vi.unstubAllGlobals();
});

describe('file action lifecycle', () => {
    it('coalesces a repeated copy and invalidates every same-Project Session tree', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [
                    session('session-a', 'project-1'),
                    session('session-b', 'project-1'),
                    session('session-c', 'project-2'),
                ],
            } as unknown as BootstrapState,
        });
        const directory = '/project';
        const source = `${directory}/source.txt`;
        const copy = deferred<{
            kind: 'file';
            name: string;
            path: string;
        }>();
        mocks.request.mockReturnValue(copy.promise);
        queryClient.setQueryData(
            controlledViewQueryKey(client.viewId, 'files.list', { directory }),
            [],
        );

        const first = duplicateFile(client, 'session-a', source);
        const repeated = duplicateFile(client, 'session-a', source);

        expect(mocks.request).toHaveBeenCalledTimes(1);
        expect(useFileOperationStore.getState().operations).toEqual([
            expect.objectContaining({ label: 'Copying item…', projectId: 'project-1' }),
        ]);
        await expect(repeated).resolves.toBeUndefined();

        copy.resolve({
            kind: 'file',
            name: 'source copy.txt',
            path: `${directory}/source copy.txt`,
        });
        await expect(first).resolves.toMatchObject({ name: 'source copy.txt' });

        expect(useFileOperationStore.getState().operations).toEqual([]);
        expect(
            queryClient.getQueryState(
                controlledViewQueryKey(client.viewId, 'files.list', { directory }),
            )?.isInvalidated,
        ).toBe(true);
    });

    it('keeps a staged move pending after the UI deadline and reconciles its late success', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'operation-timeout' });
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const staged: FileMutationOperation = {
            id: 'operation-timeout',
            kind: 'move',
            ...operationScope,
            phase: 'staged',
            input: {
                path: '/project/source.txt',
                directory: '/project/destination',
                conflict: 'reject',
            },
            expectedResult: {
                device: '1',
                inode: '2',
                kind: 'file',
                name: 'source.txt',
                path: '/project/destination/source.txt',
                previousPath: '/project/source.txt',
            },
            startedAt: 1,
            updatedAt: 2,
        };
        mocks.request.mockImplementation((method) => {
            if (method === 'files.move')
                return Promise.reject(new CaxriError('TIMEOUT', 'Runtime request timed out'));
            if (method === 'files.operation.cancel') return Promise.resolve(staged);
            return Promise.resolve(null);
        });

        await expect(
            moveFile(client, 'session-a', '/project/source.txt', '/project/destination'),
        ).resolves.toBeUndefined();

        expect(useFileOperationStore.getState().operations).toEqual([
            expect.objectContaining({
                id: staged.id,
                label: 'Moving item in background…',
            }),
        ]);
        expect(getToasts()).toContainEqual(
            expect.objectContaining({
                type: 'info',
                title: 'File change is still finishing safely in the background',
            }),
        );

        const completed: FileMutationOperation = {
            ...staged,
            phase: 'completed',
            result: staged.expectedResult,
            updatedAt: 3,
        };
        await reconcileFileMutation(client, completed);

        expect(useFileOperationStore.getState().operations).toEqual([]);
        expect(mocks.request).toHaveBeenCalledWith('files.operation.acknowledge', {
            operationId: staged.id,
        });
    });

    it('keeps a staged rename in the background while final persistence retries', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'operation-final-retry' });
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const staged: FileMutationOperation = {
            id: 'operation-final-retry',
            kind: 'rename',
            ...operationScope,
            phase: 'staged',
            input: { path: '/project/source.txt', name: 'renamed.txt' },
            expectedResult: {
                device: '1',
                inode: '2',
                kind: 'file',
                name: 'renamed.txt',
                path: '/project/renamed.txt',
                previousPath: '/project/source.txt',
            },
            startedAt: 1,
            updatedAt: 2,
        };
        mocks.request.mockImplementation((method) => {
            if (method === 'files.rename')
                return Promise.reject(new CaxriError('IO', 'Journal write failed'));
            if (method === 'files.operation.get') return Promise.resolve(staged);
            return Promise.resolve(null);
        });

        await expect(
            renameFile(client, 'session-a', '/project/source.txt', 'renamed.txt'),
        ).resolves.toBeUndefined();
        expect(useFileOperationStore.getState().operations).toEqual([
            expect.objectContaining({
                id: staged.id,
                label: 'Renaming item in background…',
            }),
        ]);
    });

    it('does not toast when Move to Trash is canceled', async () => {
        mocks.request.mockResolvedValue({ canceled: true });

        await expect(didTrashFile(client, 'session-a', '/project/source.txt')).resolves.toBe(false);

        expect(getToasts()).toEqual([]);
    });

    it('tells Main about unsaved changes and keeps a persistent notice that they were discarded', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [
                    {
                        ...operationScope,
                        desiredSecondarySidebarViewContainerId: 'caxri.files',
                        paneLayout: paneLayout('/project/source.txt'),
                    },
                ],
                terminals: [],
            } as unknown as BootstrapState,
        });
        useSessionViewStore.getState().cacheDocument('session-a', {
            path: '/project/source.txt',
            content: 'unsaved',
            dirty: true,
            mtimeMs: 1,
            size: 7,
        });
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'source.txt',
            path: '/project/source.txt',
        });

        await expect(didTrashFile(client, 'session-a', '/project/source.txt')).resolves.toBe(true);

        expect(mocks.request).toHaveBeenCalledWith('files.trash', {
            sessionId: 'session-a',
            path: '/project/source.txt',
            hasUnsavedChanges: true,
        });
        expect(getToasts()).toContainEqual(
            expect.objectContaining({
                type: 'warning',
                duration: Infinity,
                title: "Moved 'source.txt' to Trash. Unsaved changes were discarded; only the last saved version can be restored.",
            }),
        );
        expect(getToasts()).toHaveLength(1);
    });

    it('cleans the Workbench Root the confirmation was about, not the one in effect afterwards', async () => {
        // An Agent creating a worktree switches a Session's root with no user action, and the confirmation dialog can be
        // open for seconds. Re-deriving the root after the await would leave the trashed file's dirty buffer behind,
        // which is exactly the resurrection #738 closed.
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [
                    {
                        ...operationScope,
                        desiredSecondarySidebarViewContainerId: 'caxri.files',
                        paneLayout: paneLayout('/project/source.txt'),
                    },
                ],
                terminals: [],
            } as unknown as BootstrapState,
        });
        useSessionViewStore.getState().cacheDocument('session-a', {
            path: '/project/source.txt',
            content: 'unsaved',
            dirty: true,
            mtimeMs: 1,
            size: 7,
        });
        mocks.request.mockImplementation((method: string) => {
            if (method !== 'files.trash') return Promise.resolve(null);
            useWorkbenchStore.setState((state) => ({
                bootstrap: {
                    ...state.bootstrap!,
                    // Only the Workbench Root moves; a Session's owner Project is fixed for its lifetime.
                    sessions: [session('session-a', 'project-1', 'project-2')],
                } as BootstrapState,
            }));
            return Promise.resolve({
                kind: 'file',
                name: 'source.txt',
                path: '/project/source.txt',
            });
        });

        await expect(didTrashFile(client, 'session-a', '/project/source.txt')).resolves.toBe(true);

        expect(mocks.request).toHaveBeenCalledWith('files.trash', {
            sessionId: 'session-a',
            path: '/project/source.txt',
            hasUnsavedChanges: true,
        });
        expect(useSessionViewStore.getState().documents['session-a']).toEqual({});
        // The durable snapshot cleanup has to name the same root: it is the only copy for a Session parked elsewhere.
        expect(mocks.request).toHaveBeenCalledWith('session.workbenchRoot.forgetEditorPath', {
            ...operationScope,
            path: '/project/source.txt',
        });
    });

    it('reports no unsaved changes for a clean file', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [
                    {
                        ...operationScope,
                        desiredSecondarySidebarViewContainerId: 'caxri.files',
                        paneLayout: paneLayout('/project/source.txt'),
                    },
                ],
                terminals: [],
            } as unknown as BootstrapState,
        });
        useSessionViewStore.getState().cacheDocument('session-a', {
            path: '/project/source.txt',
            content: 'saved',
            dirty: false,
            mtimeMs: 1,
            size: 5,
        });
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'source.txt',
            path: '/project/source.txt',
        });

        await expect(didTrashFile(client, 'session-a', '/project/source.txt')).resolves.toBe(true);

        expect(mocks.request).toHaveBeenCalledWith('files.trash', {
            sessionId: 'session-a',
            path: '/project/source.txt',
            hasUnsavedChanges: false,
        });
        expect(getToasts()).not.toContainEqual(expect.objectContaining({ type: 'info' }));
    });
});

describe('moveFile conflict prompt', () => {
    const source = '/project/source.txt';
    const directory = '/project/destination';

    function stubSequentialOperationIds(prefix: string): void {
        let count = 0;
        vi.stubGlobal('crypto', { randomUUID: () => `${prefix}-${++count}` });
    }

    function rejectFirstAttempt(
        method: string,
        parameters: Record<string, unknown>,
    ): Promise<unknown> | undefined {
        if (method === 'files.move' && parameters.conflict === 'reject')
            return Promise.reject(
                new CaxriError('CONFLICT', 'A file or folder with that name already exists'),
            );
        if (method === 'files.list') return Promise.resolve(fileEntryListing('source.txt'));
        return undefined;
    }

    it('retries with replace and shows no error toast when the user replaces', async () => {
        stubSequentialOperationIds('conflict-replace');
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const failed: FileMutationOperation = {
            id: 'conflict-replace-1',
            kind: 'move',
            ...operationScope,
            phase: 'failed',
            input: { path: source, directory, conflict: 'reject' },
            error: { code: 'CONFLICT', message: 'A file or folder with that name already exists' },
            startedAt: 1,
            updatedAt: 2,
        };
        const movedResult = {
            kind: 'file' as const,
            name: 'source.txt',
            path: `${directory}/source.txt`,
            previousPath: source,
        };
        const completed: FileMutationOperation = {
            id: 'conflict-replace-2',
            kind: 'move',
            ...operationScope,
            phase: 'completed',
            input: { path: source, directory, conflict: 'replace' },
            result: movedResult,
            startedAt: 3,
            updatedAt: 4,
        };
        mocks.request.mockImplementation((method: string, parameters: Record<string, unknown>) => {
            const rejected = rejectFirstAttempt(method, parameters);
            if (rejected) return rejected;
            if (method === 'files.move') return Promise.resolve(movedResult);
            if (method === 'files.operation.get')
                return Promise.resolve(
                    parameters.operationId === 'conflict-replace-1' ? failed : completed,
                );
            return Promise.resolve(null);
        });

        const movePromise = moveFile(client, 'session-a', source, directory);
        await vi.waitFor(() => {
            expect(useFileConflictDialogStore.getState().request).toBeDefined();
        });
        expect(useFileConflictDialogStore.getState().request).toEqual({
            name: 'source.txt',
            folderGated: false,
        });
        resolveFileConflictChoice('replace');

        await expect(movePromise).resolves.toMatchObject({ name: 'source.txt' });
        expect(mocks.request).toHaveBeenCalledWith(
            'files.move',
            expect.objectContaining({ conflict: 'replace' }),
        );
        expect(getToasts().some((toast) => toast.type === 'error')).toBe(false);
        expect(getToasts()).toContainEqual(
            expect.objectContaining({ type: 'success', title: "'source.txt' moved" }),
        );
    });

    it('retries with rename when the user keeps both', async () => {
        stubSequentialOperationIds('conflict-keep-both');
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const failed: FileMutationOperation = {
            id: 'conflict-keep-both-1',
            kind: 'move',
            ...operationScope,
            phase: 'failed',
            input: { path: source, directory, conflict: 'reject' },
            error: { code: 'CONFLICT', message: 'A file or folder with that name already exists' },
            startedAt: 1,
            updatedAt: 2,
        };
        const movedResult = {
            kind: 'file' as const,
            name: 'source copy.txt',
            path: `${directory}/source copy.txt`,
            previousPath: source,
        };
        const completed: FileMutationOperation = {
            id: 'conflict-keep-both-2',
            kind: 'move',
            ...operationScope,
            phase: 'completed',
            input: { path: source, directory, conflict: 'rename' },
            result: movedResult,
            startedAt: 3,
            updatedAt: 4,
        };
        mocks.request.mockImplementation((method: string, parameters: Record<string, unknown>) => {
            const rejected = rejectFirstAttempt(method, parameters);
            if (rejected) return rejected;
            if (method === 'files.move') return Promise.resolve(movedResult);
            if (method === 'files.operation.get')
                return Promise.resolve(
                    parameters.operationId === 'conflict-keep-both-1' ? failed : completed,
                );
            return Promise.resolve(null);
        });

        const movePromise = moveFile(client, 'session-a', source, directory);
        await vi.waitFor(() => {
            expect(useFileConflictDialogStore.getState().request).toBeDefined();
        });
        resolveFileConflictChoice('keep-both');

        await expect(movePromise).resolves.toMatchObject({ name: 'source copy.txt' });
        expect(mocks.request).toHaveBeenCalledWith(
            'files.move',
            expect.objectContaining({ conflict: 'rename' }),
        );
    });

    it('cancels without a toast and leaves a cut clipboard entry armed', async () => {
        stubSequentialOperationIds('conflict-cancel');
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const failed: FileMutationOperation = {
            id: 'conflict-cancel-1',
            kind: 'move',
            ...operationScope,
            phase: 'failed',
            input: { path: source, directory, conflict: 'reject' },
            error: { code: 'CONFLICT', message: 'A file or folder with that name already exists' },
            startedAt: 1,
            updatedAt: 2,
        };
        mocks.request.mockImplementation((method: string, parameters: Record<string, unknown>) => {
            const rejected = rejectFirstAttempt(method, parameters);
            if (rejected) return rejected;
            if (method === 'files.operation.get') return Promise.resolve(failed);
            return Promise.resolve(null);
        });
        useFileClipboardStore.getState().set({ mode: 'cut', path: source, projectId: 'project-1' });

        const pastePromise = pasteFile(client, 'session-a', 'project-1', directory, {
            mode: 'cut',
            path: source,
            projectId: 'project-1',
        });
        await vi.waitFor(() => {
            expect(useFileConflictDialogStore.getState().request).toBeDefined();
        });
        resolveFileConflictChoice('cancel');

        await expect(pastePromise).resolves.toBeUndefined();
        expect(mocks.request).not.toHaveBeenCalledWith(
            'files.move',
            expect.objectContaining({ conflict: 'replace' }),
        );
        expect(mocks.request).not.toHaveBeenCalledWith(
            'files.move',
            expect.objectContaining({ conflict: 'rename' }),
        );
        expect(useFileClipboardStore.getState().entry).toEqual({
            mode: 'cut',
            path: source,
            projectId: 'project-1',
        });
        expect(getToasts().some((toast) => toast.type === 'error')).toBe(false);
    });

    it('toasts a non-CONFLICT first-attempt failure exactly once', async () => {
        stubSequentialOperationIds('generic-failure');
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const failed: FileMutationOperation = {
            id: 'generic-failure-1',
            kind: 'move',
            ...operationScope,
            phase: 'failed',
            input: { path: source, directory, conflict: 'reject' },
            error: { code: 'IO', message: 'Disk is full' },
            startedAt: 1,
            updatedAt: 2,
        };
        mocks.request.mockImplementation((method: string) => {
            if (method === 'files.move')
                return Promise.reject(new CaxriError('IO', 'Disk is full'));
            if (method === 'files.operation.get') return Promise.resolve(failed);
            return Promise.resolve(null);
        });

        // Before the fix, `reconcileFileMutation`'s failed branch only suppressed a CONFLICT toast,
        // so a non-CONFLICT failure toasted once there and again in `moveFile`'s catch. The
        // suppression registry is now blind to the error code, so this must toast exactly once.
        await expect(moveFile(client, 'session-a', source, directory)).resolves.toBeUndefined();

        const errorToasts = getToasts().filter((toast) => toast.type === 'error');
        expect(errorToasts).toMatchObject([{ title: 'Unable to move item. Disk is full.' }]);
    });

    it('does not leak a suppression entry after a conflict-free move succeeds', async () => {
        stubSequentialOperationIds('no-leak');
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const movedResult = {
            kind: 'file' as const,
            name: 'source.txt',
            path: `${directory}/source.txt`,
            previousPath: source,
        };
        const completed: FileMutationOperation = {
            id: 'no-leak-1',
            kind: 'move',
            ...operationScope,
            phase: 'completed',
            input: { path: source, directory, conflict: 'reject' },
            result: movedResult,
            startedAt: 1,
            updatedAt: 2,
        };
        mocks.request.mockImplementation((method: string) => {
            if (method === 'files.move') return Promise.resolve(movedResult);
            if (method === 'files.operation.get') return Promise.resolve(completed);
            return Promise.resolve(null);
        });

        expect(failureToastSuppressionSizeForTests()).toBe(0);
        await expect(moveFile(client, 'session-a', source, directory)).resolves.toMatchObject({
            name: 'source.txt',
        });
        // A conflict-free move never reaches `didConsumeFailureToastSuppression` (only the failed
        // branch of `reconcileFileMutation` calls it), so only `moveFile`'s own `finally` can clear
        // the registration it made before this attempt. Without that `finally`, this entry would
        // stay registered for the life of the Renderer.
        expect(failureToastSuppressionSizeForTests()).toBe(0);
    });
});

describe('inline create and rename conflicts', () => {
    const conflict = new CaxriError('CONFLICT', 'A file or folder with that name already exists');

    function failedOperation(
        kind: 'create' | 'rename',
        input: Record<string, unknown>,
    ): FileMutationOperation {
        return {
            id: `${kind}-conflict-1`,
            kind,
            sessionId: 'session-a',
            phase: 'failed',
            input,
            error: { code: 'CONFLICT', message: conflict.message },
            startedAt: 1,
            updatedAt: 2,
        } as FileMutationOperation;
    }

    beforeEach(() => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
    });

    // The inline name field already explains the conflict, so reconciling the failed durable operation must not
    // raise a second, identical notification (issue #987).
    it('propagates a create conflict to the inline field without a toast', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'create-conflict-1' });
        const failed = failedOperation('create', {
            directory: '/project/src',
            name: 'duplicate.txt',
            kind: 'file',
        });
        mocks.request.mockImplementation((method: string) => {
            if (method === 'files.create') return Promise.reject(conflict);
            if (method === 'files.operation.get') return Promise.resolve(failed);
            return Promise.resolve(null);
        });

        await expect(
            createItem(client, 'session-a', '/project/src', 'duplicate.txt', 'file'),
        ).rejects.toBe(conflict);

        expect(getToasts()).toEqual([]);
        expect(failureToastSuppressionSizeForTests()).toBe(0);
    });

    it('propagates a rename conflict to the inline field without a toast', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'rename-conflict-1' });
        const failed = failedOperation('rename', {
            path: '/project/created.txt',
            name: 'draft.txt',
        });
        mocks.request.mockImplementation((method: string) => {
            if (method === 'files.rename') return Promise.reject(conflict);
            if (method === 'files.operation.get') return Promise.resolve(failed);
            return Promise.resolve(null);
        });

        await expect(
            renameFile(client, 'session-a', '/project/created.txt', 'draft.txt'),
        ).rejects.toBe(conflict);

        expect(getToasts()).toEqual([]);
        expect(failureToastSuppressionSizeForTests()).toBe(0);
    });
});
