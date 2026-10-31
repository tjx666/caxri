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
import { didUndoReplacedMove, moveFile } from '../file-actions';
import {
    resolveFileConflictChoice,
    useFileConflictDialogStore,
} from '../file-conflict-dialog-store';
import { useFileOperationStore } from '../file-operation-state';
import type { ResourceExplorerClient } from '../resource-explorer-client';

const source = '/project/a/x.txt';
const directory = '/project/b';
const undo = {
    name: 'x.txt',
    path: `${directory}/x.txt`,
    previousPath: source,
    undoToken: 'receipt-1',
};

const restoreTrashed = vi.fn<(undoToken: string) => Promise<unknown>>();

const client = {
    viewId: 'files-view',
    getOperation: (operationId: string) => mocks.request('files.operation.get', { operationId }),
    list: () => mocks.request('files.list', {}),
    move: (options: Record<string, unknown>) =>
        mocks.request('files.move', { sessionId: 'session-a', ...options }),
    restoreTrashed,
} as unknown as ResourceExplorerClient;

afterEach(() => {
    mocks.request.mockReset();
    restoreTrashed.mockReset();
    queryClient.clear();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useFileOperationStore.setState({ operations: [] });
    dismissToast();
});

describe('Replace move Undo', () => {
    it('offers Undo when Replace moved the overwritten file to Trash', async () => {
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
        const result = {
            kind: 'file' as const,
            name: 'x.txt',
            path: undo.path,
            previousPath: source,
            replacedUndoToken: 'receipt-1',
        };
        mocks.request.mockImplementation((method, parameters) => {
            if (method === 'files.move' && parameters.conflict === 'reject')
                return Promise.reject(new CaxriError('CONFLICT', 'exists'));
            if (method === 'files.list')
                return Promise.resolve([{ name: 'x.txt', path: undo.path, kind: 'file' }]);
            if (method === 'files.move') return Promise.resolve(result);
            if (method === 'files.operation.get')
                return Promise.resolve({
                    id: parameters.operationId,
                    kind: 'move',
                    sessionId: 'session-a',
                    workbenchRootProjectId: 'project-1',
                    phase: 'completed',
                    input: { path: source, directory, conflict: 'replace' },
                    result,
                    startedAt: 1,
                    updatedAt: 2,
                });
            return Promise.resolve(null);
        });

        const moving = moveFile(client, 'session-a', source, directory);
        await vi.waitFor(() => {
            expect(useFileConflictDialogStore.getState().request).toBeDefined();
        });
        resolveFileConflictChoice('replace');
        await moving;

        expect(getToasts().map((toast) => toast.title)).toContain(
            "Replaced 'x.txt'. The old file is in Trash.",
        );
    });

    it('moves the file back before restoring the overwritten one', async () => {
        const order: string[] = [];
        mocks.request.mockImplementation((method) => {
            order.push(method);
            return Promise.resolve(null);
        });
        restoreTrashed.mockImplementation(() => {
            order.push('restoreTrashed');
            return Promise.resolve({ kind: 'file', name: 'x.txt', path: source });
        });

        await expect(didUndoReplacedMove(client, undo)).resolves.toBe(true);

        expect(order.slice(0, 2)).toEqual(['files.move', 'restoreTrashed']);
        expect(restoreTrashed).toHaveBeenCalledWith('receipt-1');
    });

    it('keeps the overwritten file in Trash when the moved file cannot return', async () => {
        mocks.request.mockRejectedValue(new CaxriError('CONFLICT', 'exists'));

        await expect(didUndoReplacedMove(client, undo)).resolves.toBe(false);

        expect(restoreTrashed).not.toHaveBeenCalled();
        expect(getToasts()).toHaveLength(1);
    });
});
