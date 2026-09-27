import type {
    AppSettings,
    BootstrapState,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
    AgentSystemNotification,
    AgentSystemNotificationHandle,
} from '../agent-notifications';
import { createAgentNotificationCoordinator } from '../agent-notifications';

function session(patch: Partial<SessionRecord> & Pick<SessionRecord, 'id'>): SessionRecord {
    const { id, ...overrides } = patch;
    return {
        id,
        projectId: 'project-1',
        workbenchProjectId: 'project-1',
        rootPath: '/project',
        createdAt: 1,
        lastOpenedAt: 1,
        sidebarOrder: 0,
        lastSessionActivityAt: 1_000,
        lastSessionActivityReason: 'created',
        lastActivityState: 'completed',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        displayTitle: 'Investigate hooks',
        titleMode: 'automatic',
        primaryAgentTerminalId: 'terminal-1',
        ...overrides,
    };
}

function terminal(patch: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind: 'claude',
        provider: 'claude',
        cwd: '/project',
        title: 'Claude Code',
        icon: 'claude',
        orderIndex: 0,
        lastProcessState: 'running',
        createdAt: 1,
        updatedAt: 1,
        ...patch,
    };
}

function bootstrap(
    current: SessionRecord,
    settings: AppSettings = defaultAppSettings,
): BootstrapState {
    return {
        projects: [],
        sessions: [current],
        terminals: [terminal({ sessionId: current.id })],
        selectedSessionId: undefined,
        sessionStates: [],
        settings,
        keybindings: [],
        keybindingConflicts: [],
        theme: {},
        runtime: { status: 'ready', restartCount: 0 },
    } as unknown as BootstrapState;
}

function harness(initial: SessionRecord) {
    let current = initial;
    let selectedSessionId: string | undefined;
    let isVisible = false;
    let settings = defaultAppSettings;
    const shown: AgentSystemNotification[] = [];
    const clicks: Array<() => void> = [];
    const closed: boolean[] = [];
    const activateSession = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const coordinator = createAgentNotificationCoordinator({
        activateSession,
        isSessionVisible: (sessionId, selected) => isVisible && selected === sessionId,
        loadBootstrap: () =>
            Promise.resolve({ ...bootstrap(current, settings), selectedSessionId }),
        loadRecords: () =>
            Promise.resolve({
                sessions: [current],
                terminals: [terminal({ sessionId: current.id })],
            }),
        loadSettings: () => Promise.resolve(settings),
        showNotification: (notification, onClick): AgentSystemNotificationHandle => {
            shown.push(notification);
            clicks.push(onClick);
            const index = closed.push(false) - 1;
            return { close: () => (closed[index] = true) };
        },
    });
    return {
        activateSession,
        clicks,
        closed,
        coordinator,
        select(sessionId: string | undefined): void {
            selectedSessionId = sessionId;
        },
        setSession(next: SessionRecord): void {
            current = next;
        },
        setSettings(next: AppSettings): void {
            settings = next;
        },
        setVisible(isNextVisible: boolean): void {
            isVisible = isNextVisible;
        },
        shown,
    };
}

const recordsChanged = {
    event: 'state.changed',
    payload: { kind: 'records', sessionIds: ['session-1'], terminalIds: [] },
} satisfies ServerEvent;

describe('Agent notification coordinator', () => {
    it('does not replay unread attention from the startup baseline', async () => {
        const test = harness(
            session({
                id: 'session-1',
                attentionEpoch: 2,
                hasUnread: true,
                lastAttentionKind: 'waiting',
            }),
        );

        await test.coordinator.initialize();
        await test.coordinator.flush();

        expect(test.shown).toEqual([]);
    });

    it('notifies immediately when a background Claude Session waits for input', async () => {
        const initial = session({ id: 'session-1' });
        const test = harness(initial);
        await test.coordinator.initialize();
        test.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                hasUnread: true,
                lastActivityState: 'waiting',
                lastAttentionKind: 'waiting',
                lastSessionActivityAt: 2_000,
                lastSessionActivityReason: 'agent_waiting',
            }),
        );

        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();

        expect(test.shown).toEqual([
            {
                id: 'caxri-agent-session-session-1',
                groupId: 'caxri-agent-sessions',
                title: 'Investigate hooks',
                body: 'Claude Code is waiting for your input.',
            },
        ]);
    });

    it('announces an unnamed Session by its provider instead of the neutral default', async () => {
        const test = harness(session({ id: 'session-1', displayTitle: 'Untitled' }));
        await test.coordinator.initialize();
        test.setSession(
            session({
                ...session({ id: 'session-1', displayTitle: 'Untitled', attentionEpoch: 1 }),
                hasUnread: true,
                lastActivityState: 'waiting',
                lastAttentionKind: 'waiting',
                lastSessionActivityAt: 2_000,
                lastSessionActivityReason: 'agent_waiting',
            }),
        );
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();
        expect(test.shown.map((shown) => shown.title)).toEqual(['Claude Code session']);
    });

    it('only notifies for a completed turn after the configured duration', async () => {
        const running = session({
            id: 'session-1',
            lastActivityState: 'running',
            lastSessionActivityAt: 10_000,
            lastSessionActivityReason: 'agent_started',
        });
        const shortTurn = harness(running);
        await shortTurn.coordinator.initialize();

        shortTurn.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                hasUnread: true,
                lastAttentionKind: 'completed',
                lastSessionActivityAt: 69_999,
                lastSessionActivityReason: 'agent_completed',
            }),
        );
        shortTurn.coordinator.observe(recordsChanged);
        await shortTurn.coordinator.flush();
        expect(shortTurn.shown).toEqual([]);

        const longTurn = harness(running);
        await longTurn.coordinator.initialize();
        longTurn.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                hasUnread: true,
                lastAttentionKind: 'completed',
                lastSessionActivityAt: 70_000,
                lastSessionActivityReason: 'agent_completed',
            }),
        );
        longTurn.coordinator.observe(recordsChanged);
        await longTurn.coordinator.flush();
        expect(longTurn.shown).toHaveLength(1);
        expect(longTurn.shown[0]?.body).toBe('Claude Code completed a turn.');
    });

    it('does not let a secondary Terminal submission reset the primary Agent turn duration', async () => {
        const test = harness(
            session({
                id: 'session-1',
                lastActivityState: 'running',
                lastSessionActivityAt: 10_000,
                lastSessionActivityReason: 'agent_started',
            }),
        );
        await test.coordinator.initialize();
        test.setSession(
            session({
                id: 'session-1',
                lastActivityState: 'running',
                lastSessionActivityAt: 50_000,
                lastSessionActivityReason: 'user_submission',
            }),
        );
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();

        test.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                hasUnread: true,
                lastAttentionKind: 'completed',
                lastSessionActivityAt: 70_000,
                lastSessionActivityReason: 'agent_completed',
            }),
        );
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();

        expect(test.shown).toHaveLength(1);
    });

    it('suppresses the selected foreground Session and routes a click to the exact source', async () => {
        const test = harness(session({ id: 'session-1' }));
        await test.coordinator.initialize();
        test.select('session-1');
        test.setVisible(true);
        test.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                hasUnread: true,
                lastAttentionKind: 'waiting',
            }),
        );
        test.coordinator.observe({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'session.select' },
        });
        await test.coordinator.flush();
        expect(test.shown).toEqual([]);

        test.setVisible(false);
        test.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 2,
                hasUnread: true,
                lastAttentionKind: 'waiting',
            }),
        );
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();
        test.clicks[0]?.();
        await test.coordinator.flush();

        expect(test.activateSession).toHaveBeenCalledWith('session-1');
        expect(test.closed).toEqual([true]);
    });

    it('closes delivered notifications when attention is read or notifications are disabled', async () => {
        const test = harness(session({ id: 'session-1' }));
        await test.coordinator.initialize();
        test.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                hasUnread: true,
                lastAttentionKind: 'waiting',
            }),
        );
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();

        test.setSettings({ ...defaultAppSettings, 'agents.notifications.enabled': false });
        test.coordinator.observe({ event: 'settings.changed', payload: { source: '{}' } });
        await test.coordinator.flush();
        expect(test.closed).toEqual([true]);

        test.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                readAttentionEpoch: 1,
                hasUnread: false,
                lastAttentionKind: 'waiting',
            }),
        );
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();
        expect(test.shown).toHaveLength(1);
    });

    /**
     * `settings.changed` carries only its source, so every setting reaches this coordinator. Closing on all of them
     * made a background Agent's banner vanish when the user changed an unrelated preference such as the editor font.
     */
    it('keeps a live banner when an unrelated setting changes', async () => {
        const test = harness(session({ id: 'session-1' }));
        await test.coordinator.initialize();
        test.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                hasUnread: true,
                lastAttentionKind: 'waiting',
            }),
        );
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();
        expect(test.closed).toEqual([false]);

        test.setSettings({ ...defaultAppSettings, 'terminal.fontSize': 18 });
        test.coordinator.observe({ event: 'settings.changed', payload: { source: '{}' } });
        await test.coordinator.flush();

        expect(test.closed).toEqual([false]);
        expect(test.shown).toHaveLength(1);
    });

    it('keeps a live banner when only the completion threshold changes', async () => {
        const test = harness(session({ id: 'session-1' }));
        await test.coordinator.initialize();
        test.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                hasUnread: true,
                lastAttentionKind: 'waiting',
            }),
        );
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();

        test.setSettings({
            ...defaultAppSettings,
            'agents.notifications.completionThresholdSeconds': 120,
        });
        test.coordinator.observe({ event: 'settings.changed', payload: { source: '{}' } });
        await test.coordinator.flush();

        // The threshold only gates future completions; a banner already earned under the old value stays.
        expect(test.closed).toEqual([false]);
    });

    /**
     * Re-enabling notifications must not replay attention the user has already seen in the Sidebar. The dedup rule is
     * the epoch baseline: a banner needs an `attentionEpoch` newer than the one the coordinator already recorded.
     */
    it('does not reissue a banner when notifications are re-enabled on an unchanged epoch', async () => {
        const test = harness(session({ id: 'session-1' }));
        await test.coordinator.initialize();
        const unread = session({
            id: 'session-1',
            attentionEpoch: 1,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        test.setSession(unread);
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();
        expect(test.shown).toHaveLength(1);

        test.setSettings({ ...defaultAppSettings, 'agents.notifications.enabled': false });
        test.coordinator.observe({ event: 'settings.changed', payload: { source: '{}' } });
        await test.coordinator.flush();
        expect(test.closed).toEqual([true]);

        test.setSettings(defaultAppSettings);
        test.coordinator.observe({ event: 'settings.changed', payload: { source: '{}' } });
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();
        expect(test.shown).toHaveLength(1);

        test.setSession(session({ ...unread, attentionEpoch: 2 }));
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();
        expect(test.shown).toHaveLength(2);
    });

    it('fails closed once a refreshed notification settings load is rejected', async () => {
        const initial = session({ id: 'session-1' });
        let current = initial;
        const closed: boolean[] = [];
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap: () => Promise.resolve(bootstrap(current)),
            loadRecords: () => Promise.resolve({ sessions: [current], terminals: [terminal()] }),
            loadSettings: () => Promise.reject(new Error('Host unavailable')),
            showNotification: () => {
                const index = closed.push(false) - 1;
                return { close: () => (closed[index] = true) };
            },
        });
        await coordinator.initialize();
        current = session({
            id: 'session-1',
            attentionEpoch: 1,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        coordinator.observe(recordsChanged);
        await coordinator.flush();

        coordinator.observe({ event: 'settings.changed', payload: { source: '{}' } });
        /**
         * Teardown now waits for the reload, because only the reloaded values reveal whether a notification setting
         * changed at all. A reload that rejects still fails closed, one scheduled task later.
         */
        expect(closed).toEqual([false]);
        await coordinator.flush();
        expect(closed).toEqual([true]);
    });

    it('closes a delivered notification after a disabled reconnect with an unchanged epoch', async () => {
        const initial = session({ id: 'session-1' });
        let current = initial;
        let settings = defaultAppSettings;
        const closed: boolean[] = [];
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap: () => Promise.resolve(bootstrap(current, settings)),
            loadRecords: () => Promise.resolve({ sessions: [current], terminals: [terminal()] }),
            loadSettings: () => Promise.resolve(settings),
            showNotification: () => {
                const index = closed.push(false) - 1;
                return { close: () => (closed[index] = true) };
            },
        });
        await coordinator.initialize();
        current = session({
            id: 'session-1',
            attentionEpoch: 1,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        coordinator.observe(recordsChanged);
        await coordinator.flush();

        settings = { ...defaultAppSettings, 'agents.notifications.enabled': false };
        coordinator.observe({
            event: 'host.connectionChanged',
            payload: {
                status: 'reconnected',
                attempt: 1,
                downtimeMs: 1,
                isHostReplaced: false,
            },
        });
        await coordinator.flush();

        expect(closed).toEqual([true]);
    });

    it('does not show an in-flight notification after application disposal', async () => {
        const initial = session({ id: 'session-1' });
        const next = session({
            id: 'session-1',
            attentionEpoch: 1,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        const recordsStarted = Promise.withResolvers<void>();
        const recordsResult = Promise.withResolvers<{
            sessions: SessionRecord[];
            terminals: TerminalRecord[];
        }>();
        const showNotification = vi.fn();
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap: () => Promise.resolve(bootstrap(initial)),
            loadRecords: () => {
                recordsStarted.resolve();
                return recordsResult.promise;
            },
            loadSettings: () => Promise.resolve(defaultAppSettings),
            showNotification,
        });
        await coordinator.initialize();

        coordinator.observe(recordsChanged);
        await recordsStarted.promise;
        coordinator.dispose();
        recordsResult.resolve({ sessions: [next], terminals: [terminal()] });
        await coordinator.flush();

        expect(showNotification).not.toHaveBeenCalled();
    });

    it('lets an in-flight Session selection invalidate a stale background decision', async () => {
        const initial = session({ id: 'session-1' });
        const next = session({
            id: 'session-1',
            attentionEpoch: 1,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        let current = initial;
        const selection: { sessionId?: string } = {};
        const recordsStarted = Promise.withResolvers<void>();
        const recordsResult = Promise.withResolvers<{
            sessions: SessionRecord[];
            terminals: TerminalRecord[];
        }>();
        const showNotification = vi.fn();
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: (sessionId, selected) => selected === sessionId,
            loadBootstrap: () =>
                Promise.resolve({ ...bootstrap(current), selectedSessionId: selection.sessionId }),
            loadRecords: () => {
                recordsStarted.resolve();
                return recordsResult.promise;
            },
            loadSettings: () => Promise.resolve(defaultAppSettings),
            showNotification,
        });
        await coordinator.initialize();

        current = next;
        coordinator.observe(recordsChanged);
        await recordsStarted.promise;
        selection.sessionId = 'session-1';
        coordinator.observe({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'session.select' },
        });
        recordsResult.resolve({ sessions: [next], terminals: [terminal()] });
        await coordinator.flush();

        expect(showNotification).not.toHaveBeenCalled();
    });

    it('does not reuse a prior turn start after a disconnected short turn completes', async () => {
        const running = session({
            id: 'session-1',
            lastActivityState: 'running',
            lastSessionActivityAt: 10_000,
            lastSessionActivityReason: 'agent_started',
        });
        const test = harness(running);
        await test.coordinator.initialize();
        test.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                hasUnread: true,
                lastAttentionKind: 'completed',
                lastSessionActivityAt: 70_000,
                lastSessionActivityReason: 'agent_completed',
            }),
        );
        test.coordinator.observe(recordsChanged);
        await test.coordinator.flush();
        expect(test.shown).toHaveLength(1);

        test.setSession(
            session({
                id: 'session-1',
                attentionEpoch: 2,
                hasUnread: true,
                lastAttentionKind: 'completed',
                lastSessionActivityAt: 80_000,
                lastSessionActivityReason: 'agent_completed',
            }),
        );
        test.coordinator.observe({
            event: 'host.connectionChanged',
            payload: {
                status: 'reconnected',
                attempt: 1,
                downtimeMs: 5_000,
                isHostReplaced: false,
            },
        });
        await test.coordinator.flush();

        expect(test.shown).toHaveLength(1);
    });

    it('reconciles attention emitted while the startup baseline is in flight', async () => {
        const initial = session({ id: 'session-1' });
        const next = session({
            id: 'session-1',
            attentionEpoch: 1,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        const initialBootstrap = Promise.withResolvers<BootstrapState>();
        let current = initial;
        const showNotification = vi.fn(() => ({ close: vi.fn() }));
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap: vi
                .fn<() => Promise<BootstrapState>>()
                .mockReturnValueOnce(initialBootstrap.promise)
                .mockImplementation(() => Promise.resolve(bootstrap(current))),
            loadRecords: () => Promise.resolve({ sessions: [current], terminals: [terminal()] }),
            loadSettings: () => Promise.resolve(defaultAppSettings),
            showNotification,
        });

        const initializing = coordinator.initialize();
        current = next;
        coordinator.observe(recordsChanged);
        initialBootstrap.resolve(bootstrap(initial));
        await initializing;
        await coordinator.flush();

        expect(showNotification).toHaveBeenCalledTimes(1);
    });

    it('ignores high-frequency record changes from unrelated Shell Terminals', async () => {
        const initial = session({ id: 'session-1' });
        const loadRecords = vi.fn(() =>
            Promise.resolve({ sessions: [initial], terminals: [terminal()] }),
        );
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap: () => Promise.resolve(bootstrap(initial)),
            loadRecords,
            loadSettings: () => Promise.resolve(defaultAppSettings),
            showNotification: vi.fn(),
        });
        await coordinator.initialize();

        coordinator.observe({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: ['shell-terminal'] },
        });
        await coordinator.flush();

        expect(loadRecords).not.toHaveBeenCalled();
    });

    it('refreshes a Shell Terminal when the same record event promotes its Session to Agent', async () => {
        const initial = session({ id: 'session-1', primaryAgentTerminalId: undefined });
        const promoted = session({
            id: 'session-1',
            primaryAgentTerminalId: 'terminal-1',
            attentionEpoch: 1,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        const promotedTerminal = terminal();
        const loadRecords = vi.fn(() =>
            Promise.resolve({ sessions: [promoted], terminals: [promotedTerminal] }),
        );
        const showNotification = vi.fn(() => ({ close: vi.fn() }));
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap: () =>
                Promise.resolve({
                    ...bootstrap(initial),
                    terminals: [terminal({ kind: 'shell', provider: undefined })],
                }),
            loadRecords,
            loadSettings: () => Promise.resolve(defaultAppSettings),
            showNotification,
        });
        await coordinator.initialize();

        coordinator.observe({
            event: 'state.changed',
            payload: {
                kind: 'records',
                sessionIds: ['session-1'],
                terminalIds: ['terminal-1'],
            },
        });
        await coordinator.flush();

        expect(loadRecords).toHaveBeenCalledWith({
            sessionIds: ['session-1'],
            terminalIds: ['terminal-1'],
        });
        expect(showNotification).toHaveBeenCalledTimes(1);
    });

    it('reports a startup reconciliation failure without throwing into Desktop startup', async () => {
        const onError = vi.fn();
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap: () => Promise.reject(new Error('Host unavailable')),
            loadRecords: () => Promise.resolve({ sessions: [], terminals: [] }),
            loadSettings: () => Promise.resolve(defaultAppSettings),
            onError,
            showNotification: vi.fn(),
        });

        await expect(coordinator.initialize()).resolves.toBeUndefined();

        expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it('retries a transient startup failure on the next state event', async () => {
        const initial = session({ id: 'session-1' });
        const loadBootstrap = vi
            .fn<() => Promise<BootstrapState>>()
            .mockRejectedValueOnce(new Error('Host unavailable'))
            .mockResolvedValue(bootstrap(initial));
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap,
            loadRecords: () => Promise.resolve({ sessions: [initial], terminals: [terminal()] }),
            loadSettings: () => Promise.resolve(defaultAppSettings),
            showNotification: vi.fn(),
        });

        await coordinator.initialize();
        coordinator.observe(recordsChanged);
        await coordinator.flush();

        expect(loadBootstrap).toHaveBeenCalledTimes(2);
    });

    it('starts a fresh retry when a state event arrives during a failing startup load', async () => {
        const initial = session({ id: 'session-1' });
        const firstBootstrap = Promise.withResolvers<BootstrapState>();
        const loadBootstrap = vi
            .fn<() => Promise<BootstrapState>>()
            .mockImplementationOnce(() => firstBootstrap.promise)
            .mockResolvedValue(bootstrap(initial));
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap,
            loadRecords: () => Promise.resolve({ sessions: [initial], terminals: [terminal()] }),
            loadSettings: () => Promise.resolve(defaultAppSettings),
            showNotification: vi.fn(),
        });

        const initialization = coordinator.initialize();
        await vi.waitFor(() => expect(loadBootstrap).toHaveBeenCalledOnce());
        coordinator.observe(recordsChanged);
        firstBootstrap.reject(new Error('Host unavailable'));
        await initialization;
        await coordinator.flush();

        expect(loadBootstrap).toHaveBeenCalledTimes(2);
    });
});
