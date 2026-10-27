import type {
    AppSettings,
    BootstrapState,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createAgentNotificationCoordinator } from '../agent-notifications';

function session(patch: Partial<SessionRecord> & Pick<SessionRecord, 'id'>): SessionRecord {
    const { id, ...overrides } = patch;
    return {
        id,
        projectId: 'project-1',
        workbenchRootProjectId: 'project-1',
        rootPath: '/project',
        createdAt: 1,
        lastVisitedAt: 1,
        sidebarOrder: 0,
        sessionActivityAt: 1_000,
        sessionActivityReason: 'created',
        agentActivityState: 'completed',
        attentionGeneration: 0,
        acknowledgedAttentionGeneration: 0,
        hasUnread: false,
        title: 'Investigate hooks',
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

const recordsChanged = {
    event: 'state.changed',
    payload: { kind: 'records', sessionIds: ['session-1'], terminalIds: [] },
} satisfies ServerEvent;

const settingsChanged = {
    event: 'settings.changed',
    payload: { source: '{}' },
} satisfies ServerEvent;

describe('Agent notification settings refresh races', () => {
    it('suppresses a new notification while a settings refresh is pending', async () => {
        const initial = session({ id: 'session-1' });
        const next = session({
            id: 'session-1',
            attentionGeneration: 1,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        const recordsStarted = Promise.withResolvers<void>();
        const recordsResult = Promise.withResolvers<{
            sessions: SessionRecord[];
            terminals: TerminalRecord[];
        }>();
        const settingsStarted = Promise.withResolvers<void>();
        const settingsResult = Promise.withResolvers<AppSettings>();
        const onNotificationsSuppressed = vi.fn();
        const showNotification = vi.fn(() => ({ close: vi.fn() }));
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap: () => Promise.resolve(bootstrap(initial)),
            loadRecords: () => {
                recordsStarted.resolve();
                return recordsResult.promise;
            },
            loadSettings: () => {
                settingsStarted.resolve();
                return settingsResult.promise;
            },
            onNotificationsSuppressed,
            showNotification,
        });
        await coordinator.initialize();

        coordinator.observe(recordsChanged);
        await recordsStarted.promise;
        coordinator.observe(settingsChanged);
        recordsResult.resolve({ sessions: [next], terminals: [terminal()] });
        await settingsStarted.promise;

        expect(showNotification).not.toHaveBeenCalled();

        settingsResult.resolve({ ...defaultAppSettings, 'agents.notifications.enabled': false });
        await coordinator.flush();
        expect(onNotificationsSuppressed).toHaveBeenCalledWith(1);
    });

    it('keeps consecutive settings refreshes fenced through failure and recovers when re-enabled', async () => {
        const initial = session({ id: 'session-1' });
        let current = initial;
        const next = session({
            id: 'session-1',
            attentionGeneration: 1,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        const recordsStarted = Promise.withResolvers<void>();
        const recordsResult = Promise.withResolvers<{
            sessions: SessionRecord[];
            terminals: TerminalRecord[];
        }>();
        const firstRefresh = {
            started: Promise.withResolvers<void>(),
            result: Promise.withResolvers<AppSettings>(),
        };
        const secondRefresh = {
            started: Promise.withResolvers<void>(),
            result: Promise.withResolvers<AppSettings>(),
        };
        const refreshes: Array<typeof firstRefresh | undefined> = [firstRefresh, secondRefresh];
        let refreshIndex = 0;
        let recordsLoadCount = 0;
        const loadSettings = vi.fn(() => {
            const refresh = refreshes[refreshIndex++];
            if (!refresh) return Promise.resolve(defaultAppSettings);
            refresh.started.resolve();
            return refresh.result.promise;
        });
        const onNotificationsSuppressed = vi.fn();
        const showNotification = vi.fn(() => ({ close: vi.fn() }));
        const coordinator = createAgentNotificationCoordinator({
            activateSession: () => Promise.resolve(),
            isSessionVisible: () => false,
            loadBootstrap: () => Promise.resolve(bootstrap(initial)),
            loadRecords: () => {
                if (recordsLoadCount++ > 0)
                    return Promise.resolve({ sessions: [current], terminals: [terminal()] });
                recordsStarted.resolve();
                return recordsResult.promise;
            },
            loadSettings,
            onNotificationsSuppressed,
            showNotification,
        });
        await coordinator.initialize();

        current = next;
        coordinator.observe(recordsChanged);
        await recordsStarted.promise;
        coordinator.observe(settingsChanged);
        current = session({
            id: 'session-1',
            attentionGeneration: 2,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        coordinator.observe(recordsChanged);
        coordinator.observe(settingsChanged);
        recordsResult.resolve({ sessions: [next], terminals: [terminal()] });

        await firstRefresh.started.promise;
        expect(showNotification).not.toHaveBeenCalled();
        firstRefresh.result.resolve(defaultAppSettings);
        await secondRefresh.started.promise;
        expect(showNotification).not.toHaveBeenCalled();
        secondRefresh.result.reject(new Error('Host unavailable'));
        await coordinator.flush();

        expect(onNotificationsSuppressed).toHaveBeenCalledWith(2);
        expect(showNotification).not.toHaveBeenCalled();

        current = session({
            id: 'session-1',
            attentionGeneration: 3,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        coordinator.observe(recordsChanged);
        await coordinator.flush();
        expect(showNotification).not.toHaveBeenCalled();

        coordinator.observe(settingsChanged);
        await coordinator.flush();
        current = session({
            id: 'session-1',
            attentionGeneration: 4,
            hasUnread: true,
            lastAttentionKind: 'waiting',
        });
        coordinator.observe(recordsChanged);
        await coordinator.flush();

        expect(loadSettings).toHaveBeenCalledTimes(3);
        expect(showNotification).toHaveBeenCalledTimes(1);
    });
});
