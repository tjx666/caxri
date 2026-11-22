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

import { useNotificationStore } from './notifications';
import { registerSessionCommandConvergence } from './session-command-convergence';
import { useSessionViewStore } from './session-view';
import { dismissToast, getToasts } from './toasts';
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

    it('mirrors the Workbench window fullscreen state and ignores the Caxri Bot window', () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());
        expect(useWorkbenchStore.getState().isFullScreen).toBe(false);

        // The Caxri Bot window's own state also reaches this Renderer and must not move the Workbench chrome.
        for (const [window, isFullScreen, expected] of [
            ['workbench', true, true],
            ['caxriBot', false, true],
            ['workbench', false, false],
        ] as const) {
            mocks.emit({ event: 'window.fullScreen', payload: { window, isFullScreen } });
            expect(useWorkbenchStore.getState().isFullScreen).toBe(expected);
        }
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
        const payload = {
            sessionId: 'session-1',
            kind: 'file' as const,
            path: '/project/file.ts',
            location: { mode: 'line' as const, startLine: 12, endLine: 14 },
            focusEditor: true,
        };
        mocks.emit({ event: 'desktop.openRequested', payload });
        expect(handlers.onDesktopOpen).toHaveBeenCalledWith(payload);
        unsubscribe();
    });

    it('stays silent for a Workbench Root switch the user performed or an Agent led', () => {
        const unsubscribe = subscribeWorkbenchEvents(eventHandlers());

        for (const reason of ['selected', 'authorized', 'followed'] as const)
            mocks.emit({
                event: 'workbench.changed',
                payload: {
                    sessionId: 'session-1',
                    workbenchRootProjectId: 'project-worktree',
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
            projects: [{ id: 'project-1', title: 'Fixture' }],
            sessions: [{ id: sessionId, projectId: 'project-1', title: 'Session' }],
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
