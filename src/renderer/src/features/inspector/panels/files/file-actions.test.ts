import { CaxriError } from '@shared/ipc';
import type { BootstrapState, FileMutationOperation } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { caxriQueryKey, queryClient } from '../../../../queries/client';
import { dismissToast, useToastStore } from '../../../../stores/toasts';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { didTrashFile, duplicateFile, moveFile, pasteFile, renameFile } from './file-actions';
import { useFileClipboardStore } from './file-clipboard';
import {
    resolveFileConflictChoice,
    useFileConflictDialogStore,
} from './file-conflict-dialog-store';
import {
    failureToastSuppressionSizeForTests,
    reconcileFileMutation,
} from './file-operation-reconciliation';
import { useFileOperationStore } from './file-operation-state';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    const { promise, resolve } = Promise.withResolvers<T>();
    return { promise, resolve };
}

/**
A `files.list` stub that reports one plain-file entry for any directory it is asked about.
 */
function fileEntryListing(name: string): unknown[] {
    return [{ name, path: `/anywhere/${name}`, kind: 'file' }];
}

function session(id: string, projectId: string) {
    return { id, projectId, workbenchProjectId: projectId };
}

beforeEach(() => vi.stubGlobal('window', globalThis));

afterEach(() => {
    mocks.request.mockReset();
    queryClient.clear();
    useFileOperationStore.getState().clear();
    useFileClipboardStore.setState({ entry: undefined });
    useFileConflictDialogStore.setState({ request: undefined, resolve: undefined });
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
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
        for (const sessionId of ['session-a', 'session-b', 'session-c'])
            queryClient.setQueryData(caxriQueryKey('files.list', { sessionId, directory }), []);

        const first = duplicateFile('session-a', source);
        const repeated = duplicateFile('session-a', source);

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
                caxriQueryKey('files.list', { sessionId: 'session-a', directory }),
            )?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(
                caxriQueryKey('files.list', { sessionId: 'session-b', directory }),
            )?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(
                caxriQueryKey('files.list', { sessionId: 'session-c', directory }),
            )?.isInvalidated,
        ).toBe(false);
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
            sessionId: 'session-a',
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
            moveFile('session-a', '/project/source.txt', '/project/destination'),
        ).resolves.toBeUndefined();

        expect(useFileOperationStore.getState().operations).toEqual([
            expect.objectContaining({
                id: staged.id,
                label: 'Moving item in background…',
            }),
        ]);
        expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({
                kind: 'info',
                message: 'File change is still finishing safely in the background',
            }),
        );

        const completed: FileMutationOperation = {
            ...staged,
            phase: 'completed',
            result: staged.expectedResult,
            updatedAt: 3,
        };
        await reconcileFileMutation(completed);

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
            sessionId: 'session-a',
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
            renameFile('session-a', '/project/source.txt', 'renamed.txt'),
        ).resolves.toBeUndefined();
        expect(useFileOperationStore.getState().operations).toEqual([
            expect.objectContaining({
                id: staged.id,
                label: 'Renaming item in background…',
            }),
        ]);
    });

    it('confirms a successful trash with a toast naming the item', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'source.txt',
            path: '/project/source.txt',
        });

        await expect(didTrashFile('session-a', '/project/source.txt')).resolves.toBe(true);

        expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({ kind: 'success', message: "Moved 'source.txt' to Trash" }),
        );
    });

    it('does not toast when Move to Trash is canceled', async () => {
        mocks.request.mockResolvedValue({ canceled: true });

        await expect(didTrashFile('session-a', '/project/source.txt')).resolves.toBe(false);

        expect(useToastStore.getState().toasts).toEqual([]);
    });

    it('tells Main about unsaved changes and keeps a persistent notice that they were discarded', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [
                    {
                        sessionId: 'session-a',
                        workbenchProjectId: 'project-1',
                        openTabs: [{ path: '/project/source.txt', dirty: true }],
                        inspectorMode: 'files',
                        layout: {},
                    },
                ],
                terminals: [],
            } as unknown as BootstrapState,
        });
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'source.txt',
            path: '/project/source.txt',
        });

        await expect(didTrashFile('session-a', '/project/source.txt')).resolves.toBe(true);

        expect(mocks.request).toHaveBeenCalledWith('files.trash', {
            sessionId: 'session-a',
            path: '/project/source.txt',
            hasUnsavedChanges: true,
        });
        expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({
                kind: 'info',
                persist: true,
                message:
                    "Unsaved changes to 'source.txt' were discarded; only the last saved version moved to Trash",
            }),
        );
    });

    it('reports no unsaved changes for a clean file', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [session('session-a', 'project-1')],
                sessionStates: [
                    {
                        sessionId: 'session-a',
                        workbenchProjectId: 'project-1',
                        openTabs: [{ path: '/project/source.txt', dirty: false }],
                        inspectorMode: 'files',
                        layout: {},
                    },
                ],
                terminals: [],
            } as unknown as BootstrapState,
        });
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'source.txt',
            path: '/project/source.txt',
        });

        await expect(didTrashFile('session-a', '/project/source.txt')).resolves.toBe(true);

        expect(mocks.request).toHaveBeenCalledWith('files.trash', {
            sessionId: 'session-a',
            path: '/project/source.txt',
            hasUnsavedChanges: false,
        });
        expect(useToastStore.getState().toasts).not.toContainEqual(
            expect.objectContaining({ kind: 'info' }),
        );
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
            sessionId: 'session-a',
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
            sessionId: 'session-a',
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

        const movePromise = moveFile('session-a', source, directory);
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
        expect(useToastStore.getState().toasts.some((toast) => toast.kind === 'error')).toBe(false);
        expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({ kind: 'success', message: "'source.txt' moved" }),
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
            sessionId: 'session-a',
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
            sessionId: 'session-a',
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

        const movePromise = moveFile('session-a', source, directory);
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
            sessionId: 'session-a',
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

        const pastePromise = pasteFile('session-a', 'project-1', directory, {
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
        expect(useToastStore.getState().toasts.some((toast) => toast.kind === 'error')).toBe(false);
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
            sessionId: 'session-a',
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
        await expect(moveFile('session-a', source, directory)).resolves.toBeUndefined();

        const errorToasts = useToastStore
            .getState()
            .toasts.filter((toast) => toast.kind === 'error');
        expect(errorToasts).toEqual([expect.objectContaining({ message: 'Disk is full' })]);
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
            sessionId: 'session-a',
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
        await expect(moveFile('session-a', source, directory)).resolves.toMatchObject({
            name: 'source.txt',
        });
        // A conflict-free move never reaches `didConsumeFailureToastSuppression` (only the failed
        // branch of `reconcileFileMutation` calls it), so only `moveFile`'s own `finally` can clear
        // the registration it made before this attempt. Without that `finally`, this entry would
        // stay registered for the life of the Renderer.
        expect(failureToastSuppressionSizeForTests()).toBe(0);
    });
});
