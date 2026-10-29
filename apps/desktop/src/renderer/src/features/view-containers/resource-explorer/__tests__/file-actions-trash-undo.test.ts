import type { BootstrapState } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(method: string, parameters: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { queryClient } from '../../../../queries/client';
import { dismissToast, getToasts } from '../../../../stores/toasts';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { didTrashFile, didUndoTrashedFile, duplicateFile, undoLatestTrash } from '../file-actions';
import type { ResourceExplorerClient } from '../resource-explorer-client';
import { forgetUndoableTrash } from '../undoable-trash';

const client = {
    viewId: 'files-view',
    copy: (path: string, directory: string) =>
        mocks.request('files.copy', { sessionId: 'session-a', path, directory }),
    forgetEditorPath: () => Promise.resolve(null),
    restoreTrashed: (undoToken: string) =>
        mocks.request('files.restoreTrashed', { sessionId: 'session-a', undoToken }),
    trash: (path: string) => mocks.request('files.trash', { sessionId: 'session-a', path }),
} as unknown as ResourceExplorerClient;

afterEach(() => {
    forgetUndoableTrash();
    mocks.request.mockReset();
    queryClient.clear();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    dismissToast();
});

describe('Move to Trash notification', () => {
    it('confirms a successful trash with a toast naming the item', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [
                    {
                        id: 'session-a',
                        projectId: 'project-1',
                        workbenchRootProjectId: 'project-1',
                    },
                ],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'source.txt',
            path: '/project/source.txt',
        });

        await expect(didTrashFile(client, 'session-a', '/project/source.txt')).resolves.toBe(true);

        expect(getToasts()).toContainEqual(
            expect.objectContaining({ type: 'success', title: "Moved 'source.txt' to Trash" }),
        );
    });

    it('offers Undo on the single trash toast only when Server reported where the item went', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [
                    {
                        id: 'session-a',
                        projectId: 'project-1',
                        workbenchRootProjectId: 'project-1',
                    },
                ],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'source.txt',
            path: '/project/source.txt',
            undoToken: 'receipt-1',
        });

        await didTrashFile(client, 'session-a', '/project/source.txt');

        expect(getToasts()).toHaveLength(1);
        expect(getToasts()[0]).toMatchObject({ action: { label: 'Undo' } });
    });

    it('shows no Undo when the platform could not report the Trash location', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [
                    {
                        id: 'session-a',
                        projectId: 'project-1',
                        workbenchRootProjectId: 'project-1',
                    },
                ],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'source.txt',
            path: '/project/source.txt',
        });

        await didTrashFile(client, 'session-a', '/project/source.txt');

        expect(getToasts()[0]?.action).toBeUndefined();
    });
});

describe('Undo after Move to Trash', () => {
    it('confirms the restore and reports it once', async () => {
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'source.txt',
            path: '/project/source.txt',
        });

        await expect(didUndoTrashedFile(client, 'receipt-1', 'source.txt')).resolves.toBe(true);

        expect(mocks.request).toHaveBeenCalledWith('files.restoreTrashed', {
            sessionId: 'session-a',
            undoToken: 'receipt-1',
        });
        expect(getToasts()).toEqual([
            expect.objectContaining({ type: 'success', title: "Restored 'source.txt'" }),
        ]);
    });

    it('names the item when its old path is taken, instead of overwriting', async () => {
        mocks.request.mockRejectedValue(new CaxriError('CONFLICT', 'source.txt already exists'));

        await expect(didUndoTrashedFile(client, 'receipt-1', 'source.txt')).resolves.toBe(false);

        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'error',
                title: expect.stringContaining("Couldn't restore 'source.txt'") as unknown,
            }),
        ]);
    });

    it('explains an expired Undo or a missing folder', async () => {
        mocks.request.mockRejectedValue(new CaxriError('NOT_FOUND', 'gone'));

        await expect(didUndoTrashedFile(client, 'receipt-1', 'source.txt')).resolves.toBe(false);

        expect(getToasts()[0]).toMatchObject({
            title: expect.stringContaining('this Undo has expired') as unknown,
        });
    });
});

describe('Cmd+Z after Move to Trash', () => {
    async function trash(name: string, undoToken: string | undefined): Promise<void> {
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [
                    {
                        id: 'session-a',
                        projectId: 'project-1',
                        workbenchRootProjectId: 'project-1',
                    },
                ],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        mocks.request.mockResolvedValueOnce({
            kind: 'file',
            name,
            path: `/project/${name}`,
            undoToken,
        });
        await didTrashFile(client, 'session-a', `/project/${name}`);
    }

    it('restores the latest Trash once, then has nothing left to undo', async () => {
        await trash('a.txt', 'receipt-a');
        mocks.request.mockResolvedValue({ kind: 'file', name: 'a.txt', path: '/project/a.txt' });

        expect(undoLatestTrash(client, 'session-a')).toBeDefined();
        await vi.waitFor(() =>
            expect(mocks.request).toHaveBeenLastCalledWith('files.restoreTrashed', {
                sessionId: 'session-a',
                undoToken: 'receipt-a',
            }),
        );
        await vi.waitFor(() => expect(undoLatestTrash(client, 'session-a')).toBeUndefined());
    });

    it('takes back only the newest of two Trash moves', async () => {
        await trash('a.txt', 'receipt-a');
        await trash('b.txt', 'receipt-b');
        mocks.request.mockResolvedValue({ kind: 'file', name: 'b.txt', path: '/project/b.txt' });

        expect(undoLatestTrash(client, 'session-a')).toBeDefined();
        await vi.waitFor(() =>
            expect(mocks.request).toHaveBeenLastCalledWith('files.restoreTrashed', {
                sessionId: 'session-a',
                undoToken: 'receipt-b',
            }),
        );
    });

    it('does nothing after a later file operation changed the tree', async () => {
        await trash('a.txt', 'receipt-a');
        mocks.request.mockResolvedValue({
            kind: 'file',
            name: 'a copy.txt',
            path: '/project/a copy.txt',
        });
        await duplicateFile(client, 'session-a', '/project/b.txt');

        expect(undoLatestTrash(client, 'session-a')).toBeUndefined();
    });

    it('does nothing for another Session or when no Undo was offered', async () => {
        await trash('a.txt', 'receipt-a');
        expect(undoLatestTrash(client, 'session-b')).toBeUndefined();

        await trash('b.txt', undefined);
        expect(undoLatestTrash(client, 'session-a')).toBeUndefined();
    });

    it('keeps the receipt after a name conflict so the user can free the name and retry', async () => {
        await trash('a.txt', 'receipt-a');
        mocks.request.mockRejectedValue(new CaxriError('CONFLICT', 'a.txt already exists'));

        expect(undoLatestTrash(client, 'session-a')).toBeDefined();
        await vi.waitFor(() => expect(getToasts()).toHaveLength(1));
        expect(undoLatestTrash(client, 'session-a')).toBeDefined();
    });

    it('drops the receipt once the toast Undo consumed it', async () => {
        await trash('a.txt', 'receipt-a');
        mocks.request.mockResolvedValue({ kind: 'file', name: 'a.txt', path: '/project/a.txt' });
        await didUndoTrashedFile(client, 'receipt-a', 'a.txt');

        expect(undoLatestTrash(client, 'session-a')).toBeUndefined();
    });
});
