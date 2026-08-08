import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '@shared/ipc/events';
import type { BootstrapState, SessionState } from '@shared/types';

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

import {
    patchSessionState,
    refreshWorkbench,
    subscribeWorkbenchEvents,
    useWorkbenchStore,
} from './workbench';

afterEach(() => {
    mocks.request.mockClear();
    mocks.onEvent.mockClear();
    mocks.reset();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
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
        const unsubscribe = subscribeWorkbenchEvents({ onCommand: vi.fn() });

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
        const unsubscribe = subscribeWorkbenchEvents({ onCommand: vi.fn() });

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
        const unsubscribe = subscribeWorkbenchEvents({ onCommand: vi.fn() });
        mocks.emit({ event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } });

        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        expect(mocks.request.mock.calls[0]?.[0]).toBe('app.bootstrap');
        unsubscribe();
    });
});

describe('workbench Session state', () => {
    it('keeps an optimistic change when an older bootstrap request resolves', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            openTabs: [],
            inspectorMode: 'files',
            layout: {},
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

    it('keeps the optimistic state when session.updateState resolves', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            openTabs: [],
            inspectorMode: 'files',
            layout: {},
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
            openTabs: [],
            inspectorMode: 'files',
            layout: {},
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
        await updateRequest.promise.catch(() => undefined);

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([filesState]);
    });

    it('does not let a stale, failed patch clobber a newer confirmed patch', async () => {
        const filesState: SessionState = {
            sessionId: 'session-1',
            openTabs: [],
            inspectorMode: 'files',
            layout: {},
        };
        const bootstrap = {
            configurationErrors: [],
            sessionStates: [filesState],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap });

        const updateRequests: ReturnType<typeof Promise.withResolvers<SessionState>>[] = [];
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
        await updateRequests[0].promise.catch(() => undefined);

        expect(useWorkbenchStore.getState().bootstrap?.sessionStates).toEqual([agentsState]);
    });
});
