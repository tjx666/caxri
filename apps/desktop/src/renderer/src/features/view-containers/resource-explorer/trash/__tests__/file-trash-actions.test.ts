import type { BootstrapState } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(method: string, parameters: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('../../../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { queryClient } from '../../../../../queries/client';
import { useSessionViewStore } from '../../../../../stores/session-view';
import { dismissToast, getToasts } from '../../../../../stores/toasts';
import { useWorkbenchStore } from '../../../../../stores/workbench';
import type { ResourceExplorerClient } from '../../resource-explorer-client';
import { trashFiles } from '../file-trash-actions';
import { forgetUndoableTrash } from '../undoable-trash';

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

const operationScope = { sessionId: 'session-a', workbenchRootProjectId: 'project-1' } as const;

const client = {
    viewId: 'publisher.files.explorer',
    forgetEditorPath: (workbenchRootProjectId: string, path: string) =>
        mocks.request('session.workbenchRoot.forgetEditorPath', {
            sessionId: 'session-a',
            workbenchRootProjectId,
            path,
        }),
    list: (directory?: string) =>
        mocks.request('files.list', { sessionId: 'session-a', directory }),
    trash: (paths: readonly string[], options?: Parameters<ResourceExplorerClient['trash']>[1]) =>
        mocks.request('files.trash', { sessionId: 'session-a', paths, ...options }),
} as unknown as ResourceExplorerClient;

afterEach(() => {
    forgetUndoableTrash();
    mocks.request.mockReset();
    queryClient.clear();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    dismissToast();
});

describe('Move to Trash cleanup', () => {
    it('does not toast when Move to Trash is canceled', async () => {
        mocks.request.mockResolvedValue({ canceled: true });

        await expect(trashFiles(client, 'session-a', ['/project/source.txt'])).resolves.toEqual([]);

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
            items: [{ kind: 'file', name: 'source.txt', path: '/project/source.txt' }],
        });

        await expect(trashFiles(client, 'session-a', ['/project/source.txt'])).resolves.toEqual([
            '/project/source.txt',
        ]);

        expect(mocks.request).toHaveBeenCalledWith('files.trash', {
            sessionId: 'session-a',
            paths: ['/project/source.txt'],
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
                items: [{ kind: 'file', name: 'source.txt', path: '/project/source.txt' }],
            });
        });

        await expect(trashFiles(client, 'session-a', ['/project/source.txt'])).resolves.toEqual([
            '/project/source.txt',
        ]);

        expect(mocks.request).toHaveBeenCalledWith('files.trash', {
            sessionId: 'session-a',
            paths: ['/project/source.txt'],
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
            items: [{ kind: 'file', name: 'source.txt', path: '/project/source.txt' }],
        });

        await expect(trashFiles(client, 'session-a', ['/project/source.txt'])).resolves.toEqual([
            '/project/source.txt',
        ]);

        expect(mocks.request).toHaveBeenCalledWith('files.trash', {
            sessionId: 'session-a',
            paths: ['/project/source.txt'],
            hasUnsavedChanges: false,
        });
        expect(getToasts()).not.toContainEqual(expect.objectContaining({ type: 'info' }));
    });
});
