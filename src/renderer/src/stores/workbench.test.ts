import type { RuntimeEvent } from '@shared/ipc/events';
import type { BootstrapState, SessionState } from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    let listener: ((event: RuntimeEvent) => void) | undefined;
    return {
        emit: (event: RuntimeEvent) => listener?.(event),
        onEvent: vi.fn((next: (event: RuntimeEvent) => void) => {
            listener = next;
            return () => {
                listener = undefined;
            };
        }),
        request: vi.fn<(method?: unknown) => Promise<unknown>>(() =>
            Promise.resolve({ configurationErrors: [] }),
        ),
        reset: () => {
            listener = undefined;
        },
    };
});

vi.mock('../lib/caxri', () => ({
    caxri: { onEvent: mocks.onEvent, request: mocks.request },
}));

import { useSessionViewStore } from './session-view';
import { useToastStore } from './toasts';
import {
    patchSessionState,
    refreshWorkbench,
    subscribeWorkbenchEvents,
    useWorkbenchStore,
} from './workbench';

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

function eventHandlers() {
    return { onCommand: vi.fn(), onDesktopOpen: vi.fn() };
}

afterEach(() => {
    mocks.request.mockClear();
    mocks.onEvent.mockClear();
    mocks.reset();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0, isFullScreen: false });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    useToastStore.setState({ toasts: [] });
});

describe('workbench Runtime events', () => {
    it('patches a Terminal exit through app.records without requesting app.bootstrap', async () => {
        const running = { id: 'terminal-1', lastProcessState: 'running' };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [],
                terminals: [running],
            } as unknown as BootstrapState,
        });
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.records')
                return Promise.resolve({
                    sessions: [],
                    terminals: [{ ...running, lastProcessState: 'stopped' }],
                });
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        mocks.emit({
            event: 'terminal.exit',
            payload: { terminalId: 'terminal-1', exitCode: 0 },
        });
        await Promise.resolve();
        expect(mocks.request).not.toHaveBeenCalled();

        mocks.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: ['terminal-1'] },
        });
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        expect(mocks.request).toHaveBeenCalledWith('app.records', {
            sessionIds: [],
            terminalIds: ['terminal-1'],
        });
        expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([
            { ...running, lastProcessState: 'stopped' },
        ]);
        unsubscribe();
    });

    it('patches Agent Session and Terminal metadata through one scoped read', async () => {
        const session = { id: 'session-1', displayTitle: 'Codex' };
        const terminal = { id: 'terminal-1', sessionId: 'session-1' };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [session],
                terminals: [terminal],
            } as unknown as BootstrapState,
        });
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.records')
                return Promise.resolve({
                    sessions: [{ ...session, displayTitle: 'Scoped refresh' }],
                    terminals: [{ ...terminal, agentSessionId: 'agent-session-1' }],
                });
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        mocks.emit({
            event: 'state.changed',
            payload: {
                kind: 'records',
                sessionIds: ['session-1'],
                terminalIds: ['terminal-1'],
            },
        });

        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        expect(mocks.request.mock.calls[0]?.[0]).toBe('app.records');
        expect(useWorkbenchStore.getState().bootstrap).toMatchObject({
            sessions: [{ id: 'session-1', displayTitle: 'Scoped refresh' }],
            terminals: [{ id: 'terminal-1', agentSessionId: 'agent-session-1' }],
        });
        unsubscribe();
    });

    it('uses app.bootstrap for the full convergence fallback', async () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());
        mocks.emit({ event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } });

        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        expect(mocks.request.mock.calls[0]?.[0]).toBe('app.bootstrap');
        unsubscribe();
    });

    it('mirrors the native window fullscreen state', () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());
        expect(useWorkbenchStore.getState().isFullScreen).toBe(false);

        mocks.emit({ event: 'window.fullScreen', payload: { isFullScreen: true } });
        expect(useWorkbenchStore.getState().isFullScreen).toBe(true);

        mocks.emit({ event: 'window.fullScreen', payload: { isFullScreen: false } });
        expect(useWorkbenchStore.getState().isFullScreen).toBe(false);
        unsubscribe();
    });

    it('re-attaches Terminal panes and refreshes state after a Host reconnect', async () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());
        expect(useWorkbenchStore.getState().attachEpoch).toBe(0);

        mocks.emit({
            event: 'host.connectionChanged',
            payload: { status: 'reconnected', downtimeMs: 512, attempt: 1, isHostReplaced: false },
        });

        expect(useWorkbenchStore.getState().attachEpoch).toBe(1);
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        expect(mocks.request.mock.calls[0]?.[0]).toBe('app.bootstrap');
        unsubscribe();
    });

    it('keeps a visible error when another Desktop replaces this window', () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        mocks.emit({
            event: 'host.connectionChanged',
            payload: { status: 'replaced' },
        });

        expect(mocks.request).not.toHaveBeenCalled();
        expect(useToastStore.getState().toasts).toEqual([
            expect.objectContaining({
                kind: 'error',
                message:
                    'Another Caxri window took over this profile. Continue in the other window.',
                persist: true,
            }),
        ]);
        unsubscribe();
    });

    it('routes a one-shot Desktop open request without persisting it as Runtime state', () => {
        const handlers = eventHandlers();
        const unsubscribe = subscribeWorkbenchEvents(handlers);
        mocks.emit({
            event: 'desktop.openRequested',
            payload: { sessionId: 'session-1', kind: 'file', path: '/project/file.ts' },
        });
        expect(handlers.onDesktopOpen).toHaveBeenCalledWith('session-1', '/project/file.ts');
        unsubscribe();
    });

    it('reports output recovery completion and rate limiting without exposing matched text', () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        mocks.emit({
            event: 'terminal.outputRecovery',
            payload: { terminalId: 'terminal-1', provider: 'codex', status: 'recovered' },
        });
        mocks.emit({
            event: 'terminal.outputRecovery',
            payload: { terminalId: 'terminal-1', provider: 'codex', status: 'rate-limited' },
        });

        expect(useToastStore.getState().toasts).toEqual([
            expect.objectContaining({
                kind: 'success',
                message: 'Sent Esc and continue to Codex after a matched recovery rule.',
            }),
            expect.objectContaining({
                kind: 'error',
                message: 'Automatic recovery paused for Codex after 3 attempts in 10 minutes.',
            }),
        ]);
        unsubscribe();
    });
});

describe('workbench Session state', () => {
    it('keeps an optimistic change when an older bootstrap request resolves', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            inspectorMode: 'files',
            paneLayout: paneLayout(),
        };
        const staleBootstrap = {
            configurationErrors: [],
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
        const statusState = { ...filesState, inspectorMode: 'status' as const };
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
            inspectorMode: 'files',
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
        const statusState = { ...filesState, inspectorMode: 'status' as const };
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

    it('keeps the optimistic state when session.updateState resolves', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            inspectorMode: 'files',
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

        const statusState = { ...filesState, inspectorMode: 'status' as const };
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
            inspectorMode: 'files',
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

        const statusState = { ...filesState, inspectorMode: 'status' as const };
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
            inspectorMode: 'files',
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
            .patchSessionState({ ...ownerState, inspectorMode: 'status' }, undefined, rollback);
        const worktreeState: SessionState = {
            sessionId: 'session-1',
            workbenchProjectId: 'project-worktree',
            inspectorMode: 'git',
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
            inspectorMode: 'files',
            paneLayout: paneLayout('/project/source.ts'),
        };
        const bootstrap = {
            configurationErrors: [],
            sessions: [],
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
            inspectorMode: 'files',
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
            inspectorMode: 'files',
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

        const statusState = { ...filesState, inspectorMode: 'status' as const };
        patchSessionState(statusState);
        const agentsState = { ...filesState, inspectorMode: 'git' as const };
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
