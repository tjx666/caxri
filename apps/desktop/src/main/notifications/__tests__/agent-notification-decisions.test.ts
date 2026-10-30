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
            agentActivityState: 'running',
            sessionActivityAt: 10_000,
            sessionActivityReason: 'agent_started',
        });
        const app = harness(running);
        await app.coordinator.initialize();
        await app.observe(running);
        expect(app.decisions).toEqual([]);

        const completed = session({
            id: 'session-1',
            attentionGeneration: 1,
            hasUnread: true,
            lastAttentionKind: 'completed',
            sessionActivityAt: 24_999,
            sessionActivityReason: 'agent_completed',
        });
        await app.observe(completed);
        await app.observe(completed);
        expect(app.decisions).toEqual([
            {
                attentionGeneration: 1,
                attentionKind: 'completed',
                durationMs: 14_999,
                outcome: 'belowThreshold',
                sessionId: 'session-1',
            },
        ]);

        await app.observe(
            session({
                id: 'session-1',
                attentionGeneration: 2,
                hasUnread: true,
                agentActivityState: 'waiting',
                lastAttentionKind: 'waiting',
                sessionActivityAt: 80_000,
                sessionActivityReason: 'agent_waiting',
            }),
        );
        expect(app.decisions.at(-1)).toMatchObject({
            attentionGeneration: 2,
            attentionKind: 'waiting',
            outcome: 'shown',
        });
        expect(app.shown).toEqual(['Waiting for your input']);
    });

    it('names the gate that suppressed a raised attention', async () => {
        const disabled = harness(session({ id: 'session-1', agentActivityState: 'running' }), {
            ...defaultAppSettings,
            'agents.notifications.enabled': false,
        });
        await disabled.coordinator.initialize();
        await disabled.observe(
            session({
                id: 'session-1',
                attentionGeneration: 1,
                hasUnread: true,
                agentActivityState: 'waiting',
                lastAttentionKind: 'waiting',
            }),
        );
        expect(disabled.decisions).toMatchObject([
            { attentionGeneration: 1, attentionKind: 'waiting', outcome: 'disabled' },
        ]);
        expect(disabled.shown).toEqual([]);
    });
});
