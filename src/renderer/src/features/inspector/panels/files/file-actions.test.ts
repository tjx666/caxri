import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaxriError } from '@shared/ipc';
import type { BootstrapState, FileMutationOperation } from '@shared/types';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { caxriQueryKey, queryClient } from '../../../../queries/client';
import { dismissToast, useToastStore } from '../../../../stores/toasts';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { duplicateFile, moveFile, renameFile, trashFile } from './file-actions';
import { reconcileFileMutation } from './file-operation-reconciliation';
import { useFileOperationStore } from './file-operation-state';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

beforeEach(() => vi.stubGlobal('window', globalThis));

afterEach(() => {
    mocks.request.mockReset();
    queryClient.clear();
    useFileOperationStore.getState().clear();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    dismissToast();
    vi.unstubAllGlobals();
});

describe('file action lifecycle', () => {
    it('coalesces a repeated copy and invalidates every same-Project Session tree', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [
                    { id: 'session-a', projectId: 'project-1' },
                    { id: 'session-b', projectId: 'project-1' },
                    { id: 'session-c', projectId: 'project-2' },
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
                sessions: [{ id: 'session-a', projectId: 'project-1' }],
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
            moveFile('session-a', '/project/source.txt', '/project/destination', 'reject'),
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
                sessions: [{ id: 'session-a', projectId: 'project-1' }],
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
                sessions: [{ id: 'session-a', projectId: 'project-1' }],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'source.txt',
            path: '/project/source.txt',
        });

        await expect(trashFile('session-a', '/project/source.txt')).resolves.toBe(true);

        expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({ kind: 'success', message: "Moved 'source.txt' to Trash" }),
        );
    });

    it('does not toast when Move to Trash is canceled', async () => {
        mocks.request.mockResolvedValue({ canceled: true });

        await expect(trashFile('session-a', '/project/source.txt')).resolves.toBe(false);

        expect(useToastStore.getState().toasts).toEqual([]);
    });

    it('tells Main about unsaved changes and keeps a persistent notice that they were discarded', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [{ id: 'session-a', projectId: 'project-1' }],
                sessionStates: [
                    {
                        sessionId: 'session-a',
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

        await expect(trashFile('session-a', '/project/source.txt')).resolves.toBe(true);

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
                sessions: [{ id: 'session-a', projectId: 'project-1' }],
                sessionStates: [
                    {
                        sessionId: 'session-a',
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

        await expect(trashFile('session-a', '/project/source.txt')).resolves.toBe(true);

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
