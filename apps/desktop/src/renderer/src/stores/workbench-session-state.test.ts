import type { BootstrapState, SessionState } from '@caxri/protocol';
import { CaxriError, externalEditorTabPath } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    onEvent: vi.fn(() => () => {}),
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() =>
        Promise.resolve({ configurationErrors: [] }),
    ),
}));

vi.mock('../lib/caxri', () => ({
    caxri: { onEvent: mocks.onEvent, request: mocks.request },
}));

// Session-state fixtures deliberately omit unrelated bootstrap configuration.
vi.mock('./notifications', () => ({
    syncNotificationSettings: vi.fn(),
    recordNotification: vi.fn(),
    canMuteNotification: () => false,
    isNotificationMuted: () => false,
}));

import { resetExternalEditorStateForTests } from '../features/editor/external-editor-state';
import { useSessionViewStore } from './session-view';
import { dismissToast, getToasts } from './toasts';
import {
    patchSessionState,
    persistSessionState,
    refreshWorkbench,
    useWorkbenchStore,
} from './workbench';
import { resetSessionPatchesForTests } from './workbench-session-patches';

/**
 * A minimal one-pane layout; these tests only care that Session state round-trips, not about its tree shape.
 */
function paneLayout(...paths: string[]): SessionState['paneLayout'] {
    return {
        root: {
            type: 'pane',
            id: 'pane-1',
            tabs: paths.map((path, index) => ({
                id: `tab-${index}`,
                resource: { kind: 'file', path },
            })),
        },
        activePaneId: 'pane-1',
    };
}

afterEach(() => {
    mocks.request.mockClear();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0, isFullScreen: false });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    resetExternalEditorStateForTests();
    resetSessionPatchesForTests();
    dismissToast();
});

describe('workbench Session state', () => {
    it('keeps external tabs local and restores them across in-process snapshots', async () => {
        const durableState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/project/kept.ts'),
        };
        const bootstrap = {
            configurationErrors: [],
            sessions: [],
            terminals: [],
            sessionStates: [durableState],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap });
        const externalPath = externalEditorTabPath('external-1', 'outside.ts');
        const visibleState = {
            ...durableState,
            paneLayout: paneLayout('/project/kept.ts', externalPath),
        };

        await useWorkbenchStore.getState().patchSessionState(visibleState);
        expect(mocks.request).not.toHaveBeenCalled();

        mocks.request.mockImplementation((method: unknown) =>
            method === 'app.bootstrap'
                ? Promise.resolve(bootstrap)
                : Promise.reject(new Error(`Unexpected method: ${String(method)}`)),
        );
        await refreshWorkbench();
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].paneLayout).toEqual(
            visibleState.paneLayout,
        );
        expect(mocks.request).toHaveBeenCalledWith('app.bootstrap');
    });

    it('does not restore an external tab after the Renderer-only overlay is cleared', async () => {
        const durableState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/project/kept.ts'),
        };
        const bootstrap = {
            configurationErrors: [],
            sessions: [],
            terminals: [],
            sessionStates: [durableState],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap });
        const externalPath = externalEditorTabPath('external-1', 'outside.ts');
        await useWorkbenchStore.getState().patchSessionState({
            ...durableState,
            paneLayout: paneLayout('/project/kept.ts', externalPath),
        });

        resetExternalEditorStateForTests();
        mocks.request.mockResolvedValue(bootstrap);
        await refreshWorkbench();

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0]).toEqual(durableState);
    });

    it('strips external tabs when another Session field needs persistence', async () => {
        const durableState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/project/kept.ts'),
        };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [],
                terminals: [],
                sessionStates: [durableState],
            } as unknown as BootstrapState,
        });
        const externalPath = externalEditorTabPath('external-1', 'outside.ts');
        const visibleState = {
            ...durableState,
            paneLayout: paneLayout('/project/kept.ts', externalPath),
        };
        await useWorkbenchStore.getState().patchSessionState(visibleState);
        mocks.request.mockImplementation((method: unknown, state: unknown) =>
            method === 'session.updateState'
                ? Promise.resolve(state)
                : Promise.reject(new Error(`Unexpected method: ${String(method)}`)),
        );

        await useWorkbenchStore.getState().patchSessionState({
            ...visibleState,
            desiredSecondarySidebarViewContainerId: 'caxri.project-status',
        });

        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('session.updateState', {
            ...durableState,
            desiredSecondarySidebarViewContainerId: 'caxri.project-status',
        });
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].paneLayout).toEqual(
            visibleState.paneLayout,
        );
    });

    it('keeps an optimistic change when an older bootstrap request resolves', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout(),
        };
        const staleBootstrap = {
            configurationErrors: [],
            sessions: [],
            terminals: [],
            sessionStates: [filesState],
        } as unknown as BootstrapState;
        const bootstrapRequest = Promise.withResolvers<BootstrapState>();
        const updateRequest = Promise.withResolvers<SessionState>();
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.bootstrap') return bootstrapRequest.promise;
            if (method === 'session.updateState') return updateRequest.promise;
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        useWorkbenchStore.setState({ bootstrap: staleBootstrap });

        const refresh = refreshWorkbench();
        const statusState = {
            ...filesState,
            desiredSecondarySidebarViewContainerId: 'caxri.project-status' as const,
        };
        patchSessionState(statusState);
        bootstrapRequest.resolve(staleBootstrap);
        await refresh;

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([statusState]);
        updateRequest.resolve(statusState);
    });

    it('keeps a persisted change when a bootstrap read that predates the write resolves after it', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout(),
        };
        const staleBootstrap = {
            configurationErrors: [],
            sessions: [],
            terminals: [],
            sessionStates: [filesState],
        } as unknown as BootstrapState;
        const bootstrapRequest = Promise.withResolvers<BootstrapState>();
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.bootstrap') return bootstrapRequest.promise;
            if (method === 'session.updateState') return Promise.resolve(undefined);
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        useWorkbenchStore.setState({ bootstrap: staleBootstrap });

        // The snapshot read is issued first, then the patch persists fully before the read resolves
        // with a snapshot that predates the write.
        const refresh = refreshWorkbench();
        const statusState = {
            ...filesState,
            desiredSecondarySidebarViewContainerId: 'caxri.project-status' as const,
        };
        await useWorkbenchStore.getState().patchSessionState(statusState);
        bootstrapRequest.resolve(staleBootstrap);
        await refresh;

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([statusState]);

        // A read issued after the write sees the Server's converged state and is authoritative.
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    configurationErrors: [],
                    sessions: [],
                    terminals: [],
                    sessionStates: [filesState],
                });
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        await refreshWorkbench();
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([filesState]);
    });

    /**
     * Closing a Terminal while a layout write is being assembled leaves that write carrying a tab the Server has
     * already dropped. The Server stores the layout pruned and answers with it; keeping the optimistic copy instead
     * would strand the tab on screen as a blank pane, because the persisted overlay re-applies it over later
     * snapshots.
     */
    it('adopts the pruned layout the Runtime answers with instead of the state it sent', async () => {
        const sentState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/project/kept.txt', '/project/closed.txt'),
        };
        const prunedState: SessionState = {
            ...sentState,
            paneLayout: paneLayout('/project/kept.txt'),
        };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [],
                terminals: [],
                sessionStates: [sentState],
            } as unknown as BootstrapState,
        });
        mocks.request.mockImplementation((method: unknown) =>
            method === 'session.updateState'
                ? Promise.resolve(prunedState)
                : Promise.reject(new Error(`Unexpected method: ${String(method)}`)),
        );

        await useWorkbenchStore.getState().patchSessionState(sentState);

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([prunedState]);
    });

    it('keeps the optimistic state when session.updateState resolves', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout(),
        };
        const bootstrap = {
            configurationErrors: [],
            sessionStates: [filesState],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap });

        const updateRequest = Promise.withResolvers<SessionState>();
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'session.updateState') return updateRequest.promise;
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });

        const statusState = {
            ...filesState,
            desiredSecondarySidebarViewContainerId: 'caxri.project-status' as const,
        };
        patchSessionState(statusState);
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([statusState]);

        updateRequest.resolve(statusState);
        await updateRequest.promise;

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([statusState]);
    });

    it('restores the previous confirmed state when session.updateState fails', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout(),
        };
        const bootstrap = {
            configurationErrors: [],
            sessionStates: [filesState],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap });

        const updateRequest = Promise.withResolvers<SessionState>();
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'session.updateState') return updateRequest.promise;
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });

        const statusState = {
            ...filesState,
            desiredSecondarySidebarViewContainerId: 'caxri.project-status' as const,
        };
        patchSessionState(statusState);
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([statusState]);

        updateRequest.reject(new Error('rejected by Runtime'));
        try {
            await updateRequest.promise;
        } catch {
            // Expected: this test exercises the rejection path.
        }

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([filesState]);
    });

    it('does not roll a failed owner-root patch over a newer Workbench Root', async () => {
        const ownerState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-owner',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/owner/first.ts'),
        };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessionStates: [ownerState],
            } as unknown as BootstrapState,
        });
        const updateRequest = Promise.withResolvers<SessionState>();
        mocks.request.mockReturnValueOnce(updateRequest.promise);
        const rollback = vi.fn();
        const pending = useWorkbenchStore
            .getState()
            .patchSessionState(
                { ...ownerState, desiredSecondarySidebarViewContainerId: 'caxri.project-status' },
                undefined,
                rollback,
            );
        const worktreeState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-worktree',
            desiredSecondarySidebarViewContainerId: 'caxri.git',
            paneLayout: paneLayout('/worktree/second.ts'),
        };
        useWorkbenchStore.setState((current) => ({
            bootstrap: current.bootstrap
                ? { ...current.bootstrap, sessionStates: [worktreeState] }
                : undefined,
        }));

        updateRequest.reject(new Error('stale Workbench Root'));

        await expect(pending).resolves.toBe(false);
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([worktreeState]);
        expect(rollback).not.toHaveBeenCalled();
    });

    it('pins a retained optimistic state across a failed write and stale bootstrap refresh', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/project/source.ts'),
        };
        const bootstrap = {
            configurationErrors: [],
            sessions: [],
            terminals: [],
            sessionStates: [filesState],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap });
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/renamed.ts',
            content: 'dirty body',
            dirty: true,
            mtimeMs: 1,
            size: 10,
        });
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'session.updateState')
                return Promise.reject(new Error('temporary persistence failure'));
            if (method === 'app.bootstrap') return Promise.resolve(bootstrap);
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        const movedState: SessionState = {
            ...filesState,
            paneLayout: paneLayout('/project/renamed.ts'),
            editorRemapOperationId: 'operation-1',
        };

        await expect(
            useWorkbenchStore
                .getState()
                .patchSessionState(movedState, undefined, undefined, 'retain'),
        ).resolves.toBe(false);
        expect(getToasts()).toHaveLength(1);
        await refreshWorkbench();

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([movedState]);

        mocks.request.mockResolvedValueOnce(movedState);
        await useWorkbenchStore
            .getState()
            .patchSessionState(movedState, undefined, undefined, 'retain');
    });

    it('lets a bootstrap read issued after an unresolved write win once it resolves', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/project/a.ts', '/project/b.ts'),
        };
        const bootstrap = {
            configurationErrors: [],
            sessions: [],
            terminals: [],
            sessionStates: [filesState],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap });

        // An earlier, still in-flight write, e.g. selecting a newly created Terminal tab,
        // never resolves during this test.
        const updateRequest = Promise.withResolvers<SessionState>();
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'session.updateState') return updateRequest.promise;
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        const selectState: SessionState = {
            ...filesState,
            paneLayout: paneLayout('/project/a.ts', '/project/b.ts', '/project/c.ts'),
        };
        patchSessionState(selectState);

        // A later, unrelated server-side mutation (e.g. closing a Terminal) pushes a full
        // refresh. The read it issues starts after the write above was sent, so once it
        // resolves it must reflect the write's effect *and* the later mutation: it must not
        // be clobbered by the still-unresolved write's own stale optimistic snapshot.
        const convergedState: SessionState = {
            ...filesState,
            paneLayout: paneLayout('/project/a.ts', '/project/c.ts'),
        };
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    configurationErrors: [],
                    sessions: [],
                    terminals: [],
                    sessionStates: [convergedState],
                });
            if (method === 'session.updateState') return updateRequest.promise;
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        await refreshWorkbench();

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([convergedState]);

        updateRequest.resolve(selectState);
        await updateRequest.promise;
    });

    /**
     * Two layout changes for one Session go out one after the other, never side by side: sent together they would both
     * declare the revision they read, and the Server would reject the second as stale even though this Renderer is the
     * only writer. The older write failing afterwards must still not roll the Session back over the newer state that
     * has already superseded it.
     */
    it('queues a second patch for one Session behind the first', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout(),
        };
        const bootstrap = {
            configurationErrors: [],
            sessionStates: [filesState],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap });

        const updateRequests: Array<ReturnType<typeof Promise.withResolvers<SessionState>>> = [];
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'session.updateState') {
                const deferred = Promise.withResolvers<SessionState>();
                updateRequests.push(deferred);
                return deferred.promise;
            }
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });

        const statusState = {
            ...filesState,
            desiredSecondarySidebarViewContainerId: 'caxri.project-status' as const,
        };
        const olderPatch = useWorkbenchStore.getState().patchSessionState(statusState);
        const agentsState = {
            ...filesState,
            desiredSecondarySidebarViewContainerId: 'caxri.git' as const,
        };
        const newerPatch = useWorkbenchStore.getState().patchSessionState(agentsState);
        expect(updateRequests).toHaveLength(1);

        // The older patch fails; it is no longer the latest attempt, so it must not roll back or report.
        updateRequests[0].reject(new Error('stale failure'));
        await olderPatch;
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([agentsState]);

        // Only now does the queued patch reach the Server.
        await vi.waitFor(() => expect(updateRequests).toHaveLength(2));
        updateRequests[1].resolve(agentsState);
        await newerPatch;

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([agentsState]);
        expect(getToasts()).toEqual([]);
    });

    it('sends the second patch with the revision the first one stored', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 4,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout(),
        };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessionStates: [filesState],
            } as unknown as BootstrapState,
        });
        const updateRequests: Array<{
            deferred: ReturnType<typeof Promise.withResolvers<SessionState>>;
            sent: SessionState;
        }> = [];
        mocks.request.mockImplementation((method: unknown, parameters: unknown) => {
            if (method !== 'session.updateState')
                return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
            const deferred = Promise.withResolvers<SessionState>();
            updateRequests.push({ deferred, sent: parameters as SessionState });
            return deferred.promise;
        });

        const statusState = {
            ...filesState,
            desiredSecondarySidebarViewContainerId: 'caxri.project-status' as const,
        };
        const olderPatch = useWorkbenchStore.getState().patchSessionState(statusState);
        // Assembled from the same overlay, so it still carries the revision the first write read.
        const gitState = {
            ...filesState,
            desiredSecondarySidebarViewContainerId: 'caxri.git' as const,
        };
        const newerPatch = useWorkbenchStore.getState().patchSessionState(gitState);
        expect(updateRequests[0].sent.revision).toBe(4);

        updateRequests[0].deferred.resolve({ ...statusState, revision: 5 });
        await olderPatch;
        await vi.waitFor(() => expect(updateRequests).toHaveLength(2));

        expect(updateRequests[1].sent.revision).toBe(5);
        updateRequests[1].deferred.resolve({ ...gitState, revision: 6 });
        await newerPatch;
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([
            { ...gitState, revision: 6 },
        ]);
    });

    /**
     * Restoring focus to a Terminal that is already the active tab rebuilds the layout object, so the patch compares
     * unequal by reference while describing the state Server already holds. Writing it cost a round trip per focus
     * change and, worse, could only fail: the Session behind the restored focus may have just been deleted, or the
     * application may already be quitting.
     */
    it('drops a fire-and-forget patch that repeats the persisted Session state', () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/project/a.ts'),
        };
        const bootstrap = {
            configurationErrors: [],
            sessionStates: [filesState],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap });

        patchSessionState(
            { ...filesState, paneLayout: paneLayout('/project/a.ts') },
            'Unable to activate Terminal',
        );

        expect(mocks.request).not.toHaveBeenCalled();
        expect(getToasts()).toEqual([]);
        expect(useWorkbenchStore.getState().bootstrap).toBe(bootstrap);
    });

    it('keeps persisting a durable re-write of the state already applied locally', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/project/a.ts'),
        };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessionStates: [filesState],
            } as unknown as BootstrapState,
        });
        mocks.request.mockResolvedValue(filesState);

        await expect(persistSessionState({ ...filesState })).resolves.toBe(true);

        expect(mocks.request).toHaveBeenCalledWith('session.updateState', filesState);
    });

    it('stays quiet when a Session-state write is cancelled', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            revision: 0,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout(),
        };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessionStates: [filesState],
            } as unknown as BootstrapState,
        });
        mocks.request.mockImplementation((method: unknown) =>
            method === 'session.updateState'
                ? Promise.reject(new CaxriError('CANCELLED', 'Application is quitting'))
                : Promise.reject(new Error(`Unexpected method: ${String(method)}`)),
        );

        await useWorkbenchStore.getState().patchSessionState({
            ...filesState,
            desiredSecondarySidebarViewContainerId: 'caxri.project-status',
        });

        expect(getToasts()).toEqual([]);
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([filesState]);
    });

    it('adopts what won instead of rolling back when a write is rejected as stale', async () => {
        const read: SessionState = {
            sessionId: 'session-1',
            revision: 4,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/project/read.ts'),
        };
        // What the other writer stored while this one was assembling its change.
        const winner: SessionState = {
            ...read,
            revision: 5,
            paneLayout: paneLayout('/project/read.ts', '/project/winner.ts'),
        };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [],
                terminals: [],
                sessionStates: [read],
            } as unknown as BootstrapState,
        });
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'session.updateState')
                return Promise.reject(
                    new CaxriError('CONFLICT', 'Session state was written from a stale revision', {
                        currentRevision: 5,
                        writtenRevision: 4,
                    }),
                );
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    configurationErrors: [],
                    sessions: [],
                    terminals: [],
                    sessionStates: [winner],
                } as unknown as BootstrapState);
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });

        await expect(
            useWorkbenchStore.getState().patchSessionState({
                ...read,
                paneLayout: paneLayout('/project/read.ts', '/project/loser.ts'),
            }),
        ).resolves.toBe(false);
        // The refresh the rejection triggers is fire-and-forget, so let its bootstrap read settle.
        await refreshWorkbench();

        // Rolling back to `read` would have shown a layout the Server never held: it is exactly the state that
        // turned out to be stale, and re-applying it would also hide the change that actually won.
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([winner]);
        // A lost race is not something the user can act on, and the UI already converged on what won.
        expect(getToasts()).toEqual([]);
    });

    it('sends the revision it read and adopts the one the Server stored', async () => {
        const stored: SessionState = {
            sessionId: 'session-1',
            revision: 4,
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: paneLayout('/project/kept.ts'),
        };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [],
                terminals: [],
                sessionStates: [stored],
            } as unknown as BootstrapState,
        });
        const next = { ...stored, desiredSecondarySidebarViewContainerId: 'caxri.project-status' };
        mocks.request.mockImplementation((method: unknown) =>
            method === 'session.updateState'
                ? Promise.resolve({ ...next, revision: 5 })
                : Promise.reject(new Error(`Unexpected method: ${String(method)}`)),
        );

        await expect(useWorkbenchStore.getState().patchSessionState(next)).resolves.toBe(true);

        expect(mocks.request).toHaveBeenCalledWith('session.updateState', {
            ...next,
            revision: 4,
        });
        /**
         * The layout was unchanged by the write, but the revision still has to be taken from the answer: keeping the
         * one this write declared would make the very next write look stale and be rejected.
         */
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([
            { ...next, revision: 5 },
        ]);
    });
});
