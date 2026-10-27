import type {
    AppSettings,
    BootstrapState,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentNotificationDecision } from '../agent-notifications';
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

const terminal: TerminalRecord = {
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
};

const recordsChanged = {
    event: 'state.changed',
    payload: { kind: 'records', sessionIds: ['session-1'], terminalIds: [] },
} satisfies ServerEvent;

function harness(initial: SessionRecord, settings: AppSettings = defaultAppSettings) {
    let current = initial;
    const decisions: AgentNotificationDecision[] = [];
    const shown: string[] = [];
    const coordinator = createAgentNotificationCoordinator({
        activateSession: () => Promise.resolve(),
        isSessionVisible: () => false,
        loadBootstrap: () =>
            Promise.resolve({
                projects: [],
                sessions: [current],
                terminals: [terminal],
                selectedSessionId: undefined,
                sessionStates: [],
                settings,
                keybindings: [],
                keybindingConflicts: [],
                theme: {},
                runtime: { status: 'ready', restartCount: 0 },
            } as unknown as BootstrapState),
        loadRecords: () => Promise.resolve({ sessions: [current], terminals: [terminal] }),
        loadSettings: () => Promise.resolve(settings),
        onDecision: (decision) => decisions.push(decision),
        showNotification: (notification) => {
            shown.push(notification.body);
            return { close: () => {} };
        },
    });
    return {
        coordinator,
        decisions,
        async observe(next: SessionRecord): Promise<void> {
            current = next;
            coordinator.observe(recordsChanged);
            await coordinator.flush();
        },
        shown,
    };
}

/**
 * Each raised attention epoch reports exactly one decision naming the gate that decided it, so a missing or unexpected
 * banner can be explained from the log; routine record refreshes in between report nothing.
 */
describe('Agent notification decisions', () => {
    it('reports one decision per raised attention epoch', async () => {
        const running = session({
            id: 'session-1',
            lastActivityState: 'running',
            lastSessionActivityAt: 10_000,
            lastSessionActivityReason: 'agent_started',
        });
        const app = harness(running);
        await app.coordinator.initialize();
        await app.observe(running);
        expect(app.decisions).toEqual([]);

        const completed = session({
            id: 'session-1',
            attentionEpoch: 1,
            hasUnread: true,
            lastAttentionKind: 'completed',
            lastSessionActivityAt: 24_999,
            lastSessionActivityReason: 'agent_completed',
        });
        await app.observe(completed);
        await app.observe(completed);
        expect(app.decisions).toEqual([
            {
                attentionEpoch: 1,
                attentionKind: 'completed',
                durationMs: 14_999,
                outcome: 'belowThreshold',
                sessionId: 'session-1',
            },
        ]);

        await app.observe(
            session({
                id: 'session-1',
                attentionEpoch: 2,
                hasUnread: true,
                lastActivityState: 'waiting',
                lastAttentionKind: 'waiting',
                lastSessionActivityAt: 80_000,
                lastSessionActivityReason: 'agent_waiting',
            }),
        );
        expect(app.decisions.at(-1)).toMatchObject({
            attentionEpoch: 2,
            attentionKind: 'waiting',
            outcome: 'shown',
        });
        expect(app.shown).toEqual(['Waiting for your input']);
    });

    it('names the gate that suppressed a raised attention', async () => {
        const disabled = harness(session({ id: 'session-1', lastActivityState: 'running' }), {
            ...defaultAppSettings,
            'agents.notifications.enabled': false,
        });
        await disabled.coordinator.initialize();
        await disabled.observe(
            session({
                id: 'session-1',
                attentionEpoch: 1,
                hasUnread: true,
                lastActivityState: 'waiting',
                lastAttentionKind: 'waiting',
            }),
        );
        expect(disabled.decisions).toMatchObject([
            { attentionEpoch: 1, attentionKind: 'waiting', outcome: 'disabled' },
        ]);
        expect(disabled.shown).toEqual([]);
    });
});
