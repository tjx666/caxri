import type { BootstrapState, ServerEvent } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    let listener: ((event: ServerEvent) => void) | undefined;
    return {
        emit: (event: ServerEvent) => listener?.(event),
        onEvent: vi.fn((next: (event: ServerEvent) => void) => {
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

// These minimal bootstrap fixtures exercise record convergence, not configuration projection.
vi.mock(import('./notifications'), async (importOriginal) => ({
    ...(await importOriginal()),
    syncNotificationSettings: vi.fn(),
}));

import { useSessionViewStore } from './session-view';
import { dismissToast } from './toasts';
import { refreshWorkbench, subscribeWorkbenchEvents, useWorkbenchStore } from './workbench';

function eventHandlers() {
    return { onCommand: vi.fn(), onDesktopOpen: vi.fn(), onSettingsTarget: vi.fn() };
}

afterEach(() => {
    mocks.request.mockClear();
    mocks.onEvent.mockClear();
    mocks.reset();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0, isFullScreen: false });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    dismissToast();
});

/**
 * Targeted `app.records` reads and their ordering against full `app.bootstrap` snapshots.
 */
describe('workbench targeted record reads', () => {
    it('patches a Terminal exit through app.records without requesting app.bootstrap', async () => {
        const session = { id: 'session-1' };
        const running = { id: 'terminal-1', sessionId: 'session-1', lastProcessState: 'running' };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [session],
                sessionStates: [],
                terminals: [running],
            } as unknown as BootstrapState,
        });
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.records')
                return Promise.resolve({
                    sessions: [session],
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
            sessionIds: ['session-1'],
            terminalIds: ['terminal-1'],
        });
        expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([
            { ...running, lastProcessState: 'stopped' },
        ]);
        unsubscribe();
    });

    it('drops a deleted Session together with its Terminal on a targeted Terminal read', async () => {
        const session = { id: 'session-1' };
        const terminal = { id: 'terminal-1', sessionId: 'session-1', kind: 'claude' };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [session],
                sessionStates: [],
                terminals: [terminal],
            } as unknown as BootstrapState,
        });
        // Session deletion removes both rows before the per-Terminal teardown event is read back.
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.records') return Promise.resolve({ sessions: [], terminals: [] });
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        mocks.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: ['terminal-1'] },
        });
        await vi.waitFor(() =>
            expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([]),
        );

        expect(mocks.request).toHaveBeenCalledWith('app.records', {
            sessionIds: ['session-1'],
            terminalIds: ['terminal-1'],
        });
        // No intermediate state leaves the Session without its Agent Terminal (the shell-icon flash).
        expect(useWorkbenchStore.getState().bootstrap?.sessions).toEqual([]);
        unsubscribe();
    });

    it('keeps a newer targeted Terminal state when an older bootstrap resolves last', async () => {
        const running = { id: 'terminal-1', lastProcessState: 'running' };
        const dead = { ...running, lastProcessState: 'dead' };
        const staleBootstrap = {
            configurationErrors: [],
            sessions: [],
            sessionStates: [],
            terminals: [running],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap: staleBootstrap });
        const bootstrapRequest = Promise.withResolvers<BootstrapState>();
        const recordRequest = Promise.withResolvers<{
            sessions: [];
            terminals: Array<typeof dead>;
        }>();
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.bootstrap') return bootstrapRequest.promise;
            if (method === 'app.records') return recordRequest.promise;
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        const staleRefresh = refreshWorkbench();
        mocks.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: ['terminal-1'] },
        });
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
        recordRequest.resolve({ sessions: [], terminals: [dead] });
        await vi.waitFor(() =>
            expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([dead]),
        );

        bootstrapRequest.resolve(staleBootstrap);
        await staleRefresh;

        expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([dead]);
        unsubscribe();
    });

    it('lets a newer bootstrap supersede an older targeted Terminal read', async () => {
        const running = { id: 'terminal-1', lastProcessState: 'running' };
        const dead = { ...running, lastProcessState: 'dead' };
        const restarted = { ...running, updatedAt: 2 };
        const staleMissing = { id: 'terminal-2', lastProcessState: 'running' };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [],
                sessionStates: [],
                terminals: [running],
            } as unknown as BootstrapState,
        });
        const recordRequest = Promise.withResolvers<{
            sessions: [];
            terminals: Array<typeof dead | typeof staleMissing>;
        }>();
        const bootstrapRequest = Promise.withResolvers<BootstrapState>();
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.records') return recordRequest.promise;
            if (method === 'app.bootstrap') return bootstrapRequest.promise;
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        mocks.emit({
            event: 'state.changed',
            payload: {
                kind: 'records',
                sessionIds: [],
                terminalIds: ['terminal-1', 'terminal-2'],
            },
        });
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        const newerRefresh = refreshWorkbench();
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
        bootstrapRequest.resolve({
            configurationErrors: [],
            sessions: [],
            sessionStates: [],
            terminals: [restarted],
        } as unknown as BootstrapState);
        await newerRefresh;
        recordRequest.resolve({ sessions: [], terminals: [dead, staleMissing] });
        await recordRequest.promise;
        await Promise.resolve();

        expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([restarted]);
        unsubscribe();
    });

    it('keeps a targeted deletion against an older bootstrap and accepts a later recreation', async () => {
        const running = { id: 'terminal-1', lastProcessState: 'running' };
        const staleBootstrap = {
            configurationErrors: [],
            sessions: [],
            sessionStates: [],
            terminals: [running],
        } as unknown as BootstrapState;
        useWorkbenchStore.setState({ bootstrap: staleBootstrap });
        const bootstrapRequest = Promise.withResolvers<BootstrapState>();
        const recordRequest = Promise.withResolvers<{ sessions: []; terminals: [] }>();
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.bootstrap') return bootstrapRequest.promise;
            if (method === 'app.records') return recordRequest.promise;
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        const staleRefresh = refreshWorkbench();
        mocks.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: ['terminal-1'] },
        });
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
        recordRequest.resolve({ sessions: [], terminals: [] });
        await vi.waitFor(() =>
            expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([]),
        );
        bootstrapRequest.resolve(staleBootstrap);
        await staleRefresh;
        expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([]);

        const recreated = { ...running, updatedAt: 2 };
        mocks.request.mockResolvedValueOnce({
            configurationErrors: [],
            sessions: [],
            sessionStates: [],
            terminals: [recreated],
        });
        await refreshWorkbench();
        expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([recreated]);
        unsubscribe();
    });

    it('does not advance a Terminal watermark when a targeted read fails', async () => {
        const running = { id: 'terminal-1', lastProcessState: 'running' };
        const dead = { ...running, lastProcessState: 'dead' };
        const stopped = { ...running, lastProcessState: 'stopped' };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [],
                sessionStates: [],
                terminals: [running],
            } as unknown as BootstrapState,
        });
        mocks.request.mockImplementationOnce((method: unknown) => {
            expect(method).toBe('app.records');
            return Promise.reject(new Error('targeted read failed'));
        });
        mocks.request.mockImplementationOnce((method: unknown) => {
            expect(method).toBe('app.bootstrap');
            return Promise.resolve({
                configurationErrors: [],
                sessions: [],
                sessionStates: [],
                terminals: [dead],
            });
        });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        mocks.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: ['terminal-1'] },
        });
        await vi.waitFor(() =>
            expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([dead]),
        );

        mocks.request.mockResolvedValueOnce({ sessions: [], terminals: [stopped] });
        mocks.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: ['terminal-1'] },
        });
        await vi.waitFor(() =>
            expect(useWorkbenchStore.getState().bootstrap?.terminals).toEqual([stopped]),
        );
        expect(mocks.request.mock.calls.map(([method]) => method)).toEqual([
            'app.records',
            'app.bootstrap',
            'app.records',
        ]);
        unsubscribe();
    });

    it('patches Agent Session and Terminal metadata through one scoped read', async () => {
        const session = { id: 'session-1', title: 'Codex' };
        const terminal = { id: 'terminal-1', sessionId: 'session-1' };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [session],
                sessionStates: [],
                terminals: [terminal],
            } as unknown as BootstrapState,
        });
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.records')
                return Promise.resolve({
                    sessions: [{ ...session, title: 'Scoped refresh' }],
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
            sessions: [{ id: 'session-1', title: 'Scoped refresh' }],
            terminals: [{ id: 'terminal-1', agentSessionId: 'agent-session-1' }],
        });
        unsubscribe();
    });
});
