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
import { didTrashFile, didUndoTrashedFile } from '../file-actions';
import type { ResourceExplorerClient } from '../resource-explorer-client';

const client = {
    viewId: 'files-view',
    forgetEditorPath: () => Promise.resolve(null),
    restoreTrashed: (undoToken: string) =>
        mocks.request('files.restoreTrashed', { sessionId: 'session-a', undoToken }),
    trash: (path: string) => mocks.request('files.trash', { sessionId: 'session-a', path }),
} as unknown as ResourceExplorerClient;

afterEach(() => {
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
