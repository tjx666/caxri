import type { SessionState } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    queueEditorNavigation: vi.fn(),
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
    revealEditorNavigation: vi.fn(),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock('../editor-reveal', () => ({
    queueEditorNavigation: mocks.queueEditorNavigation,
    revealEditorNavigation: mocks.revealEditorNavigation,
}));

import { getSessionDocuments, useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import {
    changeDocument,
    openEditorTab,
    openFile,
    openFileForSession,
    remapOpenEditors,
    saveActiveEditor,
} from '../document-commands';
import { closeOpenEditorsUnderPath } from '../document-trash';
import {
    activePaneTabPath,
    closeEditor,
    installEmptySession,
    installSessions,
    paneLayout,
    paneTabPaths,
} from './document-commands.fixture';

it('does not edit or send a save request for a read-only dependency document', async () => {
    const path = '/project/node_modules/example/index.d.ts';
    installSessions(path, 'session-1');
    useSessionViewStore.getState().cacheDocument('session-1', {
        path,
        content: 'export {};',
        dirty: false,
        mtimeMs: 1,
        size: 10,
        readOnly: true,
    });
    changeDocument('session-1', 'project-1', path, 'changed');
    await saveActiveEditor();
    expect(getSessionDocuments('session-1')?.[path]).toMatchObject({
        content: 'export {};',
        dirty: false,
        readOnly: true,
    });
    expect(mocks.request).not.toHaveBeenCalledWith('files.write', expect.anything());
});

it('keeps edits in the pane Session when another Session is selected', () => {
    const path = '/project/shared.ts';
    installSessions(path, 'session-2', path);

    changeDocument('session-1', 'project-1', path, 'owner edit');

    expect(getSessionDocuments('session-1')?.[path]).toMatchObject({
        content: 'owner edit',
        dirty: true,
    });
    expect(getSessionDocuments('session-2')?.[path]).toMatchObject({
        content: 'other unsaved',
        dirty: true,
    });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    const { promise, resolve } = Promise.withResolvers<T>();
    return { promise, resolve };
}

afterEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
});

describe('session-scoped file mutation completion', () => {
    it('restores preview cache and focus when tab persistence fails', async () => {
        installEmptySession();
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessionStates: [
                          {
                              ...state.bootstrap.sessionStates[0],
                              paneLayout: paneLayout([
                                  { path: '/project/first.ts', preview: true },
                              ]),
                          },
                      ],
                  }
                : undefined,
        }));
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/first.ts',
            content: 'first body',
            dirty: false,
            mtimeMs: 1,
            size: 10,
        });
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/second.ts',
            content: 'second body',
            dirty: false,
            mtimeMs: 1,
            size: 11,
        });
        mocks.request.mockRejectedValueOnce(new Error('persistence failed'));

        openEditorTab('/project/second.ts', { preview: true });
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        await Promise.resolve();

        const state = useWorkbenchStore.getState().bootstrap!.sessionStates[0];
        expect(paneTabPaths(state)).toEqual(['/project/first.ts']);
        expect(activePaneTabPath(state)).toBe('/project/first.ts');
        const documents = useSessionViewStore.getState().documents['session-1'];
        expect(Object.keys(documents)).toEqual(['/project/first.ts']);
        expect(documents['/project/first.ts']).toMatchObject({ content: 'first body' });
    });

    it('does not roll preview state into a newly selected Workbench Root', async () => {
        installEmptySession();
        const updateRequest = Promise.withResolvers<unknown>();
        mocks.request.mockReturnValueOnce(updateRequest.promise);

        openEditorTab('/owner/second.ts', { preview: true });
        const worktreeState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchProjectId: 'project-2',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout(['/worktree/keep.ts']),
        };
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessions: state.bootstrap.sessions.map((session) => ({
                          ...session,
                          workbenchProjectId: 'project-2',
                      })),
                      sessionStates: [worktreeState],
                  }
                : undefined,
        }));

        updateRequest.reject(new Error('stale Workbench Root'));
        try {
            await updateRequest.promise;
        } catch {
            // expected: the assertions below verify the rejection was handled gracefully.
        }
        await Promise.resolve();

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([worktreeState]);
    });

    it('remaps the origin Session after the user selected another Session', () => {
        installSessions('/project/source.ts');

        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');

        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        const session1 = states.find((state) => state.sessionId === 'session-1')!;
        expect(paneTabPaths(session1)).toEqual(['/project/renamed.ts']);
        expect(activePaneTabPath(session1)).toBe('/project/renamed.ts');
        const session2 = states.find((state) => state.sessionId === 'session-2')!;
        expect(paneTabPaths(session2)).toEqual(['/other/session.ts']);
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/renamed.ts': { content: 'unsaved', dirty: true },
        });
    });

    it('closes only the origin Session tab after Trash confirmation returns', () => {
        installSessions('/project/trashed.ts');

        closeOpenEditorsUnderPath('project-1', '/project/trashed.ts');

        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        const session1 = states.find((state) => state.sessionId === 'session-1')!;
        expect(paneTabPaths(session1)).toEqual([]);
        const session2 = states.find((state) => state.sessionId === 'session-2')!;
        expect(paneTabPaths(session2)).toEqual(['/other/session.ts']);
        expect(useSessionViewStore.getState().documents['session-1']).toEqual({});
    });

    it('remaps the same Project file in every Session while preserving independent buffers', () => {
        installSessions('/project/source.ts', 'session-1', '/project/source.ts');

        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');

        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        expect(states.map((state) => paneTabPaths(state)[0])).toEqual([
            '/project/renamed.ts',
            '/project/renamed.ts',
        ]);
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/renamed.ts': { content: 'unsaved', dirty: true },
        });
        expect(useSessionViewStore.getState().documents['session-2']).toMatchObject({
            '/project/renamed.ts': { content: 'other unsaved', dirty: true },
        });
    });

    it('closes the same trashed Project file in every Session', () => {
        installSessions('/project/trashed.ts', 'session-1', '/project/trashed.ts');

        closeOpenEditorsUnderPath('project-1', '/project/trashed.ts');

        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        expect(states.map((state) => paneTabPaths(state))).toEqual([[], []]);
        expect(useSessionViewStore.getState().documents['session-1']).toEqual({});
        expect(useSessionViewStore.getState().documents['session-2']).toEqual({});
    });

    it('remaps a file read that completes after the file moved', async () => {
        installEmptySession();
        const read = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockReturnValueOnce(read.promise);

        const opening = openFile('/project/source.ts');
        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');
        read.resolve({ content: 'disk', mtimeMs: 1, path: '/project/source.ts', size: 4 });

        await expect(opening).resolves.toBe('/project/renamed.ts');
        const documents = getSessionDocuments('session-1');
        expect(Object.keys(documents ?? {})).toEqual(['/project/renamed.ts']);
        expect(documents?.['/project/renamed.ts']).toMatchObject({ content: 'disk', dirty: false });
        expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual([
            '/project/renamed.ts',
        ]);
    });

    it('discards a file read that completes after the file moved to Trash', async () => {
        installEmptySession();
        const read = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockReturnValueOnce(read.promise);

        const opening = openFile('/project/trashed.ts');
        closeOpenEditorsUnderPath('project-1', '/project/trashed.ts');
        read.resolve({ content: 'disk', mtimeMs: 1, path: '/project/trashed.ts', size: 4 });

        await expect(opening).resolves.toBe(false);
        expect(useSessionViewStore.getState().documents['session-1']).toBeUndefined();
        expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual([]);
    });

    it('keeps a Server-routed file bound to its target Session after selection changes', async () => {
        installSessions('/project/first-existing.ts', 'session-1', '/project/second-existing.ts');
        const read = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockImplementation((method) =>
            method === 'files.read' ? read.promise : Promise.resolve(null),
        );

        const opening = openFileForSession('session-1', '/project/host-target.ts');
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? { ...state.bootstrap, selectedSessionId: 'session-2' }
                : undefined,
        }));
        read.resolve({
            content: 'host target',
            mtimeMs: 1,
            path: '/project/host-target.ts',
            size: 11,
        });

        await expect(opening).resolves.toBe('/project/host-target.ts');
        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        const session1 = states.find((state) => state.sessionId === 'session-1')!;
        expect(paneTabPaths(session1)).toEqual([
            '/project/first-existing.ts',
            '/project/host-target.ts',
        ]);
        const session2 = states.find((state) => state.sessionId === 'session-2')!;
        expect(paneTabPaths(session2)).toEqual(['/project/second-existing.ts']);
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/host-target.ts': { content: 'host target', dirty: false },
        });
        expect(useSessionViewStore.getState().documents['session-2']).not.toHaveProperty(
            '/project/host-target.ts',
        );
    });

    it('queues a source location before activating an inactive editor tab', async () => {
        installSessions('/project/current.ts', 'session-1', '/project/other.ts');
        mocks.request.mockResolvedValueOnce({
            content: 'target',
            mtimeMs: 1,
            path: '/project/target.ts',
            size: 6,
        });

        await openFile('/project/target.ts', {
            location: { mode: 'caret', line: 3, column: 2 },
        });

        expect(mocks.queueEditorNavigation).toHaveBeenCalledWith(
            expect.stringContaining('/project/target.ts'),
            { mode: 'caret', line: 3, column: 2 },
        );
        expect(mocks.revealEditorNavigation).not.toHaveBeenCalled();
    });

    it('reveals a source location immediately when the target editor is already active', async () => {
        installSessions('/project/target.ts', 'session-1', '/project/other.ts');
        mocks.request.mockResolvedValueOnce({
            content: 'target',
            mtimeMs: 1,
            path: '/project/target.ts',
            size: 6,
        });

        await openFile('/project/target.ts', {
            location: { mode: 'line', startLine: 3, endLine: 4 },
        });

        expect(mocks.revealEditorNavigation).toHaveBeenCalledWith(
            expect.stringContaining('/project/target.ts'),
            { mode: 'line', startLine: 3, endLine: 4 },
        );
        expect(mocks.queueEditorNavigation).not.toHaveBeenCalled();
    });

    it('reopening a file with unsaved edits keeps the buffer instead of the copy on disk', async () => {
        installSessions('/project/target.ts', 'session-1', '/project/other.ts');
        mocks.request.mockResolvedValueOnce({
            content: 'disk',
            mtimeMs: 2,
            path: '/project/target.ts',
            size: 4,
        });

        await openFile('/project/target.ts');

        expect(getSessionDocuments('session-1')?.['/project/target.ts']).toMatchObject({
            content: 'unsaved',
            dirty: true,
        });
    });

    it('keeps newer dirty content when a save completes after the file moved', async () => {
        installSessions('/project/source.ts', 'session-1');
        const write = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockReturnValueOnce(write.promise);

        const saving = saveActiveEditor();
        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');
        changeDocument('session-1', 'project-1', '/project/renamed.ts', 'newer unsaved');
        write.resolve({ content: 'unsaved', mtimeMs: 2, path: '/project/source.ts', size: 7 });
        await saving;

        const documents = getSessionDocuments('session-1');
        expect(Object.keys(documents ?? {})).toEqual(['/project/renamed.ts']);
        expect(documents?.['/project/renamed.ts']).toMatchObject({
            content: 'newer unsaved',
            dirty: true,
            mtimeMs: 2,
        });
        expect(paneTabPaths(useWorkbenchStore.getState().bootstrap!.sessionStates[0])).toEqual([
            '/project/renamed.ts',
        ]);
    });

    it('does not update worktree tabs when an owner-root save completes late', async () => {
        installSessions('/owner/source.ts', 'session-1');
        const write = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockReturnValueOnce(write.promise);

        const saving = saveActiveEditor();
        const worktreeState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchProjectId: 'project-2',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout(['/worktree/keep.ts']),
        };
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessions: state.bootstrap.sessions.map((session) => ({
                          ...session,
                          workbenchProjectId: 'project-2',
                      })),
                      sessionStates: [worktreeState],
                  }
                : undefined,
        }));
        write.resolve({ content: 'unsaved', mtimeMs: 2, path: '/owner/source.ts', size: 7 });

        await saving;

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([worktreeState]);
    });
});

describe('editing the pane tree through document actions', () => {
    it('opening a new tab adds it to the pane as the active tab', () => {
        installEmptySession();

        openEditorTab('/project/new.ts');

        const state = useWorkbenchStore.getState().bootstrap!.sessionStates[0];
        expect(paneTabPaths(state)).toEqual(['/project/new.ts']);
        expect(activePaneTabPath(state)).toBe('/project/new.ts');
    });

    it('replacing a preview tab removes the replaced path from the tree', () => {
        installEmptySession();
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessionStates: [
                          {
                              ...state.bootstrap.sessionStates[0],
                              paneLayout: paneLayout([
                                  { path: '/project/preview-a.ts', preview: true },
                              ]),
                          },
                      ],
                  }
                : undefined,
        }));
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/preview-a.ts',
            content: 'a',
            dirty: false,
            mtimeMs: 1,
            size: 1,
        });

        openEditorTab('/project/preview-b.ts', { preview: true });

        const state = useWorkbenchStore.getState().bootstrap!.sessionStates[0];
        expect(paneTabPaths(state)).toEqual(['/project/preview-b.ts']);
    });

    it('closing the active tab removes it and activates its neighbor', async () => {
        installEmptySession();
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessionStates: [
                          {
                              ...state.bootstrap.sessionStates[0],
                              paneLayout: paneLayout(['/project/a.ts', '/project/b.ts']),
                          },
                      ],
                  }
                : undefined,
        }));

        await closeEditor('/project/a.ts');

        const state = useWorkbenchStore.getState().bootstrap!.sessionStates[0];
        expect(paneTabPaths(state)).toEqual(['/project/b.ts']);
        expect(activePaneTabPath(state)).toBe('/project/b.ts');
    });

    it('trashing a directory removes every descendant path from the tree', () => {
        installEmptySession();
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessionStates: [
                          {
                              ...state.bootstrap.sessionStates[0],
                              paneLayout: paneLayout([
                                  '/project/dir/a.ts',
                                  '/project/dir/b.ts',
                                  '/project/keep.ts',
                              ]),
                          },
                      ],
                  }
                : undefined,
        }));

        closeOpenEditorsUnderPath('project-1', '/project/dir');

        const state = useWorkbenchStore.getState().bootstrap!.sessionStates[0];
        expect(paneTabPaths(state)).toEqual(['/project/keep.ts']);
    });
});
