import type {
    AppSettings,
    BootstrapState,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { vi } from 'vitest';

import type {
    AgentSystemNotification,
    AgentSystemNotificationHandle,
} from '../../agent-notifications';
import { createAgentNotificationCoordinator } from '../../agent-notifications';

export function session(patch: Partial<SessionRecord> & Pick<SessionRecord, 'id'>): SessionRecord {
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

export function terminal(patch: Partial<TerminalRecord> = {}): TerminalRecord {
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

export function bootstrap(
    current: SessionRecord,
    settings: AppSettings = defaultAppSettings,
): BootstrapState {
    return {
        projects: [{ id: 'project-1', displayTitle: 'caxri' }],
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

export function harness(initial: SessionRecord) {
    let current = initial;
    let selectedSessionId: string | undefined;
    let isVisible = false;
    let settings = defaultAppSettings;
    let replySummary: () => Promise<string | undefined> = () => Promise.resolve(undefined);
    const shown: AgentSystemNotification[] = [];
    const clicks: Array<() => void> = [];
    const closed: boolean[] = [];
    const activateSession = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const coordinator = createAgentNotificationCoordinator({
        activateSession,
        isSessionVisible: (sessionId) => isVisible && selectedSessionId === sessionId,
        loadBootstrap: () => Promise.resolve(bootstrap(current, settings)),
        loadRecords: () =>
            Promise.resolve({
                sessions: [current],
                terminals: [terminal({ sessionId: current.id })],
            }),
        loadReplySummary: () => replySummary(),
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
        setReplySummary(next: () => Promise<string | undefined>): void {
            replySummary = next;
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

export const recordsChanged = {
    event: 'state.changed',
    payload: { kind: 'records', sessionIds: ['session-1'], terminalIds: [] },
} satisfies ServerEvent;
