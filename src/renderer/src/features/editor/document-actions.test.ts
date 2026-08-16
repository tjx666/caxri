import type { BootstrapState, SessionState } from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
}));

vi.mock('../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import {
    getResolvedActiveWork,
    getSessionActiveWork,
    getSessionDocuments,
    useSessionViewStore,
} from '../../stores/session-view';
import { useWorkbenchStore } from '../../stores/workbench';
import {
    changeDocument,
    closeAllEditors,
    closeEditor,
    closeOpenEditorsUnderPath,
    openEditorTab,
    openFile,
    openFileForSession,
    remapOpenEditors,
    saveActiveEditor,
} from './document-actions';

const sessionState = (sessionId: string, path: string): SessionState => ({
    sessionId,
    workbenchProjectId: 'project-1',
    openTabs: [{ path, dirty: true }],
    activeTab: { kind: 'editor', path },
    inspectorMode: 'files',
    layout: {},
});

function installSessions(
    originPath: string,
    selectedSessionId = 'session-2',
    secondSessionPath = '/other/session.ts',
): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId,
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    workbenchProjectId: 'project-1',
                },
                {
                    id: 'session-2',
                    projectId: 'project-1',
                    workbenchProjectId: 'project-1',
                },
            ],
            sessionStates: [
                sessionState('session-1', originPath),
                sessionState('session-2', secondSessionPath),
            ],
            terminals: [],
        } as unknown as BootstrapState,
    });
    useSessionViewStore.setState({ activeWork: {}, documents: {}, recentDocuments: {} });
    useSessionViewStore.getState().cacheDocument('session-1', {
        path: originPath,
        content: 'unsaved',
        dirty: true,
        mtimeMs: 1,
        size: 7,
    });
    useSessionViewStore.getState().cacheDocument('session-2', {
        path: secondSessionPath,
        content: 'other unsaved',
        dirty: true,
        mtimeMs: 1,
        size: 13,
    });
    useSessionViewStore.getState().setActiveWork('session-1', { kind: 'editor', path: originPath });
}

function installEmptySession(): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: 'session-1',
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    workbenchProjectId: 'project-1',
                },
            ],
            sessionStates: [
                {
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-1',
                    openTabs: [],
                    inspectorMode: 'files',
                    layout: {},
                },
            ],
            terminals: [],
        } as unknown as BootstrapState,
    });
    useSessionViewStore.setState({ activeWork: {}, documents: {}, recentDocuments: {} });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    const { promise, resolve } = Promise.withResolvers<T>();
    return { promise, resolve };
}

afterEach(() => {
    mocks.request.mockClear();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ activeWork: {}, documents: {}, recentDocuments: {} });
});

describe('session-scoped file mutation completion', () => {
    it('does not replace a dirty cached preview when durable tab state is stale', () => {
        installEmptySession();
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessionStates: [
                          {
                              ...state.bootstrap.sessionStates[0],
                              openTabs: [
                                  {
                                      path: '/project/unsaved.ts',
                                      dirty: false,
                                      preview: true,
                                  },
                              ],
                          },
                      ],
                  }
                : undefined,
        }));
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/unsaved.ts',
            content: 'unsaved body',
            dirty: true,
            mtimeMs: 1,
            size: 12,
        });

        openEditorTab('/project/next.ts', { preview: true });

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([
            { path: '/project/unsaved.ts', dirty: true },
            { path: '/project/next.ts', dirty: false, preview: true },
        ]);
    });

    it('restores preview cache and focus when tab persistence fails', async () => {
        installEmptySession();
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessionStates: [
                          {
                              ...state.bootstrap.sessionStates[0],
                              activeTab: { kind: 'editor', path: '/project/first.ts' },
                              openTabs: [
                                  { path: '/project/first.ts', dirty: false, preview: true },
                              ],
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
        useSessionViewStore
            .getState()
            .setActiveWork('session-1', { kind: 'editor', path: '/project/first.ts' });
        mocks.request.mockRejectedValueOnce(new Error('persistence failed'));

        openEditorTab('/project/second.ts', { preview: true });
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        await Promise.resolve();

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([
            { path: '/project/first.ts', dirty: false, preview: true },
        ]);
        expect(getResolvedActiveWork()).toEqual({
            kind: 'editor',
            path: '/project/first.ts',
        });
        expect(useSessionViewStore.getState().activeWork['session-1']).toEqual({
            kind: 'editor',
            path: '/project/first.ts',
        });
        const documents = useSessionViewStore.getState().documents['session-1'];
        expect(Object.keys(documents)).toEqual(['/project/first.ts']);
        expect(documents['/project/first.ts']).toMatchObject({ content: 'first body' });
    });

    it('does not roll preview state into a newly selected Workbench Root', async () => {
        installEmptySession();
        useSessionViewStore.getState().setActiveWork('session-1', {
            kind: 'editor',
            path: '/owner/first.ts',
        });
        const updateRequest = Promise.withResolvers<unknown>();
        mocks.request.mockReturnValueOnce(updateRequest.promise);

        openEditorTab('/owner/second.ts', { preview: true });
        const worktreeState: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-2',
            openTabs: [{ path: '/worktree/keep.ts', dirty: false }],
            activeTab: { kind: 'editor', path: '/worktree/keep.ts' },
            inspectorMode: 'files',
            layout: {},
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
        useSessionViewStore
            .getState()
            .setActiveWork('session-1', { kind: 'editor', path: '/worktree/keep.ts' }, 'project-2');

        updateRequest.reject(new Error('stale Workbench Root'));
        try {
            await updateRequest.promise;
        } catch {
            // expected: the assertions below verify the rejection was handled gracefully.
        }
        await Promise.resolve();

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([worktreeState]);
        expect(getSessionActiveWork('session-1', 'project-2')).toEqual({
            kind: 'editor',
            path: '/worktree/keep.ts',
        });
    });

    it('remaps the origin Session after the user selected another Session', () => {
        installSessions('/project/source.ts');

        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');

        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        expect(states.find((state) => state.sessionId === 'session-1')).toMatchObject({
            activeTab: { kind: 'editor', path: '/project/renamed.ts' },
            openTabs: [{ path: '/project/renamed.ts', dirty: true }],
        });
        expect(states.find((state) => state.sessionId === 'session-2')?.openTabs).toEqual([
            { path: '/other/session.ts', dirty: true },
        ]);
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/renamed.ts': { content: 'unsaved', dirty: true },
        });
    });

    it('closes only the origin Session tab after Trash confirmation returns', () => {
        installSessions('/project/trashed.ts');

        closeOpenEditorsUnderPath('session-1', '/project/trashed.ts');

        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        expect(states.find((state) => state.sessionId === 'session-1')).toMatchObject({
            activeTab: undefined,
            openTabs: [],
        });
        expect(states.find((state) => state.sessionId === 'session-2')?.openTabs).toEqual([
            { path: '/other/session.ts', dirty: true },
        ]);
        expect(useSessionViewStore.getState().documents['session-1']).toEqual({});
    });

    it('remaps the same Project file in every Session while preserving independent buffers', () => {
        installSessions('/project/source.ts', 'session-1', '/project/source.ts');

        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');

        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        expect(states.map((state) => state.openTabs[0]?.path)).toEqual([
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

        closeOpenEditorsUnderPath('session-1', '/project/trashed.ts');

        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        expect(states.map((state) => state.openTabs)).toEqual([[], []]);
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
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([
            expect.objectContaining({ path: '/project/renamed.ts' }),
        ]);
    });

    it('discards a file read that completes after the file moved to Trash', async () => {
        installEmptySession();
        const read = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockReturnValueOnce(read.promise);

        const opening = openFile('/project/trashed.ts');
        closeOpenEditorsUnderPath('session-1', '/project/trashed.ts');
        read.resolve({ content: 'disk', mtimeMs: 1, path: '/project/trashed.ts', size: 4 });

        await expect(opening).resolves.toBe(false);
        expect(useSessionViewStore.getState().documents['session-1']).toBeUndefined();
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([]);
    });

    it('keeps a Host-routed file bound to its target Session after selection changes', async () => {
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
        expect(states.find((state) => state.sessionId === 'session-1')?.openTabs).toEqual([
            { path: '/project/first-existing.ts', dirty: true },
            { path: '/project/host-target.ts', dirty: false },
        ]);
        expect(states.find((state) => state.sessionId === 'session-2')?.openTabs).toEqual([
            { path: '/project/second-existing.ts', dirty: true },
        ]);
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/host-target.ts': { content: 'host target', dirty: false },
        });
        expect(useSessionViewStore.getState().documents['session-2']).not.toHaveProperty(
            '/project/host-target.ts',
        );
    });

    it('keeps newer dirty content when a save completes after the file moved', async () => {
        installSessions('/project/source.ts', 'session-1');
        const write = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockReturnValueOnce(write.promise);

        const saving = saveActiveEditor();
        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');
        changeDocument('/project/renamed.ts', 'newer unsaved');
        write.resolve({ content: 'unsaved', mtimeMs: 2, path: '/project/source.ts', size: 7 });
        await saving;

        const documents = getSessionDocuments('session-1');
        expect(Object.keys(documents ?? {})).toEqual(['/project/renamed.ts']);
        expect(documents?.['/project/renamed.ts']).toMatchObject({
            content: 'newer unsaved',
            dirty: true,
            mtimeMs: 2,
        });
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([
            { path: '/project/renamed.ts', dirty: true },
        ]);
    });

    it('does not update worktree tabs when an owner-root save completes late', async () => {
        installSessions('/owner/source.ts', 'session-1');
        const write = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockReturnValueOnce(write.promise);

        const saving = saveActiveEditor();
        const worktreeState: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-2',
            openTabs: [{ path: '/worktree/keep.ts', dirty: true }],
            activeTab: { kind: 'editor', path: '/worktree/keep.ts' },
            inspectorMode: 'files',
            layout: {},
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

describe('closing a dirty editor tab', () => {
    it('aborts the close and keeps the tab open when the user cancels the discard confirmation', async () => {
        installSessions('/project/dirty.ts', 'session-1');
        mocks.request.mockImplementation((method) =>
            method === 'editor.confirmDiscard'
                ? Promise.resolve({ choice: 'cancel' })
                : Promise.resolve(null),
        );

        await closeEditor('/project/dirty.ts');

        expect(mocks.request).toHaveBeenCalledWith('editor.confirmDiscard', { name: 'dirty.ts' });
        expect(mocks.request).not.toHaveBeenCalledWith('files.write', expect.anything());
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0]).toMatchObject({
            openTabs: [{ path: '/project/dirty.ts', dirty: true }],
            activeTab: { kind: 'editor', path: '/project/dirty.ts' },
        });
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/dirty.ts': { dirty: true },
        });
    });

    it("closes a dirty tab without writing when the user chooses Don't Save", async () => {
        installSessions('/project/dirty.ts', 'session-1');
        mocks.request.mockImplementation((method) =>
            method === 'editor.confirmDiscard'
                ? Promise.resolve({ choice: 'discard' })
                : Promise.resolve(null),
        );

        await closeEditor('/project/dirty.ts');

        expect(mocks.request).not.toHaveBeenCalledWith('files.write', expect.anything());
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([]);
        expect(useSessionViewStore.getState().documents['session-1']).toEqual({});
    });

    it('saves a dirty tab before closing it when the user chooses Save', async () => {
        installSessions('/project/dirty.ts', 'session-1');
        mocks.request.mockImplementation((method) => {
            if (method === 'editor.confirmDiscard') return Promise.resolve({ choice: 'save' });
            if (method === 'files.write')
                return Promise.resolve({
                    content: 'unsaved',
                    mtimeMs: 2,
                    path: '/project/dirty.ts',
                    size: 7,
                });
            return Promise.resolve(null);
        });

        await closeEditor('/project/dirty.ts');

        expect(mocks.request).toHaveBeenCalledWith(
            'files.write',
            expect.objectContaining({ sessionId: 'session-1', path: '/project/dirty.ts' }),
        );
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([]);
        expect(useSessionViewStore.getState().documents['session-1']).toEqual({});
    });

    it('aborts a bulk close entirely when any dirty tab in it is canceled', async () => {
        installEmptySession();
        useWorkbenchStore.setState((state) => ({
            bootstrap: state.bootstrap
                ? {
                      ...state.bootstrap,
                      sessionStates: [
                          {
                              ...state.bootstrap.sessionStates[0],
                              openTabs: [
                                  { path: '/project/a.ts', dirty: true },
                                  { path: '/project/b.ts', dirty: true },
                              ],
                              activeTab: { kind: 'editor', path: '/project/a.ts' },
                          },
                      ],
                  }
                : undefined,
        }));
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/a.ts',
            content: 'a',
            dirty: true,
            mtimeMs: 1,
            size: 1,
        });
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/b.ts',
            content: 'b',
            dirty: true,
            mtimeMs: 1,
            size: 1,
        });
        useSessionViewStore
            .getState()
            .setActiveWork('session-1', { kind: 'editor', path: '/project/a.ts' });
        let confirmCalls = 0;
        mocks.request.mockImplementation((method) => {
            if (method === 'editor.confirmDiscard') {
                confirmCalls += 1;
                return Promise.resolve({ choice: confirmCalls === 1 ? 'discard' : 'cancel' });
            }
            return Promise.resolve(null);
        });

        await closeAllEditors('/project/a.ts');

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([
            { path: '/project/a.ts', dirty: true },
            { path: '/project/b.ts', dirty: true },
        ]);
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/a.ts': { dirty: true },
            '/project/b.ts': { dirty: true },
        });
    });
});
