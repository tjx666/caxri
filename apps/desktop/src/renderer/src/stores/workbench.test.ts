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

import { toastActionHandlers } from '../commands/toast-actions';
import { useNotificationStore } from './notifications';
import { useSessionViewStore } from './session-view';
import { configureToastActions } from './toast-actions';
import { dismissToast, getToasts } from './toasts';
import {
    refreshWorkbench,
    registerSessionCommandConvergence,
    subscribeWorkbenchEvents,
    useWorkbenchStore,
} from './workbench';

function eventHandlers() {
    return { onCommand: vi.fn(), onDesktopOpen: vi.fn(), onSettingsTarget: vi.fn() };
}

// The toast records only the name of its follow-up, so the click below reaches nothing without the window's handler
// table; `main.tsx` performs this same install before the first render.
configureToastActions(toastActionHandlers);

/**
 * Activates the Undo button of the newest toast the way the rendered notification does.
 */
function undoToast(): void {
    const action = getToasts().at(-1)?.action;
    if (typeof action !== 'object' || action === null || !('onClick' in action))
        throw new Error('The notice offered no Undo action');
    // Two spans: the visible `Undo` and the screen-reader name that says which switch it takes back, since several
    // notices can offer an `Undo` that are not the same undo.
    expect(JSON.stringify(action.label)).toContain('Undo the switch to worktree feature-entered');
    (action.onClick as unknown as () => void)();
}

afterEach(() => {
    mocks.request.mockClear();
    mocks.onEvent.mockClear();
    mocks.reset();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0, isFullScreen: false });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    dismissToast();
});

describe('workbench Runtime events', () => {
    it('keeps delivery failures from different branches separate while grouping branch repeats', () => {
        useNotificationStore.setState({ entries: [], isOpen: false, mutedTypes: [], sequence: 0 });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());
        for (const branch of ['main', 'feature', 'main']) {
            mocks.emit({
                event: 'projectStatus.alert',
                payload: {
                    sessionId: 'session-1',
                    kind: 'check',
                    repository: 'example',
                    branch,
                    name: 'Unit tests',
                },
            });
        }
        expect(useNotificationStore.getState().entries).toMatchObject([
            { projectTitle: 'example · main', count: 2 },
            { projectTitle: 'example · feature', count: 1 },
        ]);
        unsubscribe();
    });

    it('retains native notification events without producing a second popup', () => {
        useNotificationStore.setState({ entries: [], isOpen: false, mutedTypes: [], sequence: 0 });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());
        mocks.emit({
            event: 'agent.notification',
            payload: { sessionId: 'missing-session', attentionKind: 'waiting' },
        });
        mocks.emit({
            event: 'projectStatus.alert',
            payload: {
                sessionId: 'session-1',
                kind: 'check',
                repository: 'example',
                branch: 'main',
                name: 'Unit tests',
            },
        });
        expect(getToasts()).toEqual([]);
        expect(useNotificationStore.getState().entries.map((entry) => entry.message)).toEqual([
            'CI failed: Unit tests',
            'Agent is waiting for your input.',
        ]);
        unsubscribe();
    });
    it('patches a Terminal exit through app.records without requesting app.bootstrap', async () => {
        const running = { id: 'terminal-1', lastProcessState: 'running' };
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [],
                sessionStates: [],
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
        const session = { id: 'session-1', displayTitle: 'Codex' };
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

    it.each(['session.select', 'session.reorder', 'session.reorderPinned'] as const)(
        'holds %s until its delayed event-driven snapshot converges',
        async (reason) => {
            const bootstrapRequest = Promise.withResolvers<BootstrapState>();
            mocks.request.mockImplementation((method: unknown) => {
                if (method === 'app.bootstrap') return bootstrapRequest.promise;
                return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
            });
            const unsubscribe = subscribeWorkbenchEvents(eventHandlers());
            const convergence = registerSessionCommandConvergence(reason);

            await expect(
                Promise.race([convergence.promise, Promise.resolve('pending')]),
            ).resolves.toBe('pending');
            mocks.emit({
                event: 'state.changed',
                payload: { kind: 'full', reason },
            });
            await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
            await expect(
                Promise.race([convergence.promise, Promise.resolve('pending')]),
            ).resolves.toBe('pending');

            bootstrapRequest.resolve({
                configurationErrors: [],
                selectedSessionId: 'session-2',
                sessions: [{ id: 'session-2' }],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState);
            await convergence.promise;

            expect(mocks.request).toHaveBeenCalledTimes(1);
            expect(useWorkbenchStore.getState().bootstrap?.selectedSessionId).toBe('session-2');
            unsubscribe();
        },
    );

    it('mirrors the native window fullscreen state', () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());
        expect(useWorkbenchStore.getState().isFullScreen).toBe(false);

        mocks.emit({ event: 'window.fullScreen', payload: { isFullScreen: true } });
        expect(useWorkbenchStore.getState().isFullScreen).toBe(true);

        mocks.emit({ event: 'window.fullScreen', payload: { isFullScreen: false } });
        expect(useWorkbenchStore.getState().isFullScreen).toBe(false);
        unsubscribe();
    });

    it('keeps Runtime restarting until the ready snapshot converges Terminal state', async () => {
        const restarting = {
            configurationErrors: [],
            runtime: { status: 'restarting', restartCount: 1 },
            sessions: [],
            sessionStates: [],
            terminals: [{ id: 'terminal-1', lastProcessState: 'running' }],
        } as unknown as BootstrapState;
        const ready = {
            ...restarting,
            runtime: { status: 'ready', restartCount: 1 },
            terminals: [{ id: 'terminal-1', lastProcessState: 'interrupted' }],
        } as unknown as BootstrapState;
        const bootstrapRequest = Promise.withResolvers<BootstrapState>();
        useWorkbenchStore.setState({ bootstrap: restarting });
        mocks.request.mockImplementation((method: unknown) => {
            if (method === 'app.bootstrap') return bootstrapRequest.promise;
            return Promise.reject(new Error(`Unexpected method: ${String(method)}`));
        });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        mocks.emit({
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 1 },
        });

        expect(useWorkbenchStore.getState().attachEpoch).toBe(1);
        expect(useWorkbenchStore.getState().bootstrap?.runtime.status).toBe('restarting');
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledWith('app.bootstrap'));

        bootstrapRequest.resolve(ready);
        await vi.waitFor(() => expect(useWorkbenchStore.getState().bootstrap).toEqual(ready));
        unsubscribe();
    });

    it('re-attaches Terminal panes and refreshes state after a Server reconnect', async () => {
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

    it('shows an error when another Desktop replaces this window', () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        mocks.emit({
            event: 'host.connectionChanged',
            payload: { status: 'replaced' },
        });

        expect(mocks.request).not.toHaveBeenCalled();
        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'error',
                title: 'Another Caxri window took over this profile. Continue in the other window.',
                duration: 4000,
            }),
        ]);
        unsubscribe();
    });

    it('routes a one-shot Desktop open request without persisting it as Runtime state', () => {
        const handlers = eventHandlers();
        const unsubscribe = subscribeWorkbenchEvents(handlers);
        mocks.emit({
            event: 'desktop.openRequested',
            payload: {
                sessionId: 'session-1',
                kind: 'file',
                path: '/project/file.ts',
                location: { mode: 'line', startLine: 12, endLine: 14 },
                focusEditor: true,
            },
        });
        expect(handlers.onDesktopOpen).toHaveBeenCalledWith('session-1', '/project/file.ts', {
            location: { mode: 'line', startLine: 12, endLine: 14 },
            focusEditor: true,
        });
        unsubscribe();
    });

    it('announces an Agent-driven Workbench Root switch and undoes it to the captured root', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [{ id: 'session-1', workbenchProjectId: 'project-owner' }],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        mocks.emit({
            event: 'workbench.changed',
            payload: {
                sessionId: 'session-1',
                workbenchProjectId: 'project-worktree',
                reason: 'followed',
                followedProjectTitle: 'feature-entered',
            },
        });

        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'info',
                title: 'Switched to worktree "feature-entered" — an Agent moved there.',
                duration: 4_000,
            }),
        ]);
        mocks.request.mockImplementation((method: unknown) =>
            Promise.resolve(
                method === 'app.bootstrap'
                    ? { configurationErrors: [], sessions: [], sessionStates: [], terminals: [] }
                    : {},
            ),
        );
        undoToast();
        await vi.waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith('session.selectWorkbenchRoot', {
                sessionId: 'session-1',
                projectId: 'project-owner',
            }),
        );
        unsubscribe();
    });

    it('reports a failed undo as one error toast instead of an unhandled rejection', async () => {
        useWorkbenchStore.setState({
            bootstrap: {
                configurationErrors: [],
                sessions: [{ id: 'session-1', workbenchProjectId: 'project-owner' }],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());
        mocks.emit({
            event: 'workbench.changed',
            payload: {
                sessionId: 'session-1',
                workbenchProjectId: 'project-worktree',
                reason: 'followed',
                followedProjectTitle: 'feature-entered',
            },
        });
        mocks.request.mockImplementation(() =>
            Promise.reject(new Error('The worktree is no longer available.')),
        );

        undoToast();

        await vi.waitFor(() =>
            expect(getToasts()).toContainEqual(
                expect.objectContaining({
                    type: 'error',
                    title: 'Unable to return to the previous Workbench Root. The worktree is no longer available.',
                }),
            ),
        );
        unsubscribe();
    });

    it('stays silent for a Workbench Root switch the user performed', () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        for (const reason of ['selected', 'authorized'] as const)
            mocks.emit({
                event: 'workbench.changed',
                payload: {
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-worktree',
                    reason,
                },
            });

        expect(getToasts()).toEqual([]);
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

        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'success',
                title: 'Sent Esc and continue to Codex after a matched recovery rule.',
            }),
            expect.objectContaining({
                type: 'error',
                title: 'Automatic recovery paused for Codex after 3 attempts in 10 minutes.',
            }),
        ]);
        unsubscribe();
    });
});

/**
 * The live `agent.automaticNamingUnavailable` event is transient: while macOS has no window open there is no Renderer
 * to deliver it to, so the Server replays the suppressions that are still in force in every bootstrap snapshot. That
 * makes a reopened window show the reason it missed, and makes it this window's job not to repeat one it already
 * showed.
 */
describe('automatic naming sandbox notices', () => {
    /**
     * Omitting `launchId` produces the snapshot the Server sends when nothing is suppressed: the field is absent.
     */
    function snapshot(sessionId: string, launchId?: string) {
        return {
            ...(launchId && {
                automaticNamingUnavailable: [
                    { launchId, reason: 'sandboxBoundaryConflict' as const, sessionId },
                ],
            }),
            configurationErrors: [],
            projects: [{ id: 'project-1', displayTitle: 'Fixture' }],
            sessions: [{ id: sessionId, projectId: 'project-1', displayTitle: 'Session' }],
            sessionStates: [],
            terminals: [],
        } as unknown as BootstrapState;
    }

    it('reports a replayed notice once, however many times the window reconnects', async () => {
        mocks.request.mockResolvedValueOnce(snapshot('session-replay', 'launch-replay'));
        await refreshWorkbench();

        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'info',
                title: 'Fixture / Session: Automatic naming is blocked by the Project sandbox boundary. Choose a more specific Project folder and restart the Agent.',
            }),
        ]);

        dismissToast();
        mocks.request.mockResolvedValueOnce(snapshot('session-replay', 'launch-replay'));
        await refreshWorkbench();

        expect(getToasts()).toEqual([]);
    });

    it('does not repeat a notice the window already received as a live event', async () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());
        mocks.request.mockResolvedValueOnce(snapshot('session-live'));
        await refreshWorkbench();
        mocks.emit({
            event: 'agent.automaticNamingUnavailable',
            payload: {
                sessionId: 'session-live',
                launchId: 'launch-live',
                reason: 'sandboxPathUnavailable',
            },
        });
        expect(getToasts()).toHaveLength(1);
        dismissToast();

        mocks.request.mockResolvedValueOnce(snapshot('session-live', 'launch-live'));
        await refreshWorkbench();

        expect(getToasts()).toEqual([]);
        unsubscribe();
    });
});
