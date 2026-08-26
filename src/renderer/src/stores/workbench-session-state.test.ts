import type { BootstrapState, SessionState } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    onEvent: vi.fn(() => () => {}),
    request: vi.fn<(method?: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ configurationErrors: [] }),
    ),
}));

vi.mock('../lib/caxri', () => ({
    caxri: { onEvent: mocks.onEvent, request: mocks.request },
}));

import { useSessionViewStore } from './session-view';
import { patchSessionState, refreshWorkbench, useWorkbenchStore } from './workbench';

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
});

describe('workbench Session state', () => {
    it('keeps an optimistic change when an older bootstrap request resolves', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
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
            workbenchProjectId: 'project-1',
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

        // A read issued after the write sees the Runtime's converged state and is authoritative.
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
     * Closing a Terminal while a layout write is being assembled leaves that write carrying a tab the Runtime has
     * already dropped. The Runtime stores the layout pruned and answers with it; keeping the optimistic copy instead
     * would strand the tab on screen as a blank pane, because the persisted overlay re-applies it over later
     * snapshots.
     */
    it('adopts the pruned layout the Runtime answers with instead of the state it sent', async () => {
        const sentState: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
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
            workbenchProjectId: 'project-1',
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
            workbenchProjectId: 'project-1',
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
            workbenchProjectId: 'project-owner',
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
            workbenchProjectId: 'project-worktree',
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
            workbenchProjectId: 'project-1',
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
            workbenchProjectId: 'project-1',
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

        // An earlier, still in-flight write — e.g. selecting a newly created Terminal tab —
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
        // resolves it must reflect the write's effect *and* the later mutation — it must not
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

    it('does not let a stale, failed patch clobber a newer confirmed patch', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
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
        patchSessionState(statusState);
        const agentsState = {
            ...filesState,
            desiredSecondarySidebarViewContainerId: 'caxri.git' as const,
        };
        patchSessionState(agentsState);
        expect(updateRequests).toHaveLength(2);

        // The newer patch (revision for `agentsState`) confirms first.
        updateRequests[1].resolve(agentsState);
        await updateRequests[1].promise;
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([agentsState]);

        // The older, now-superseded patch (`statusState`) fails afterwards; it must not roll
        // the Session back over the confirmed newer state.
        updateRequests[0].reject(new Error('stale failure'));
        try {
            await updateRequests[0].promise;
        } catch {
            // Expected: this test exercises the rejection path.
        }

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([agentsState]);
    });
});
