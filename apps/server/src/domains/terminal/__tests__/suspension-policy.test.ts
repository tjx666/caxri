import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { TerminalActivitySample, TerminalSuspensionPolicyInput } from '../suspension-policy';
import {
    CHAT_OBSERVATION_LEASE_MS,
    decideTerminalSuspensions,
    idleSuspensionDelayMs,
    MAX_CHAT_OBSERVATION_LEASES,
    UNTOUCHED_SUSPENSION_DELAY_MS,
} from '../suspension-policy';

const NOW = 1_000_000_000;
const STARTED_AT = NOW - 24 * 60 * 60 * 1000;

function terminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: 'terminal-1',
        sessionId: 'session-a',
        kind: 'claude',
        provider: 'claude',
        cwd: '/tmp/project',
        title: 'claude',
        orderIndex: 0,
        lastProcessState: 'running',
        lastAgentProcessState: 'running',
        createdAt: STARTED_AT,
        updatedAt: STARTED_AT,
        ...overrides,
    };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: 'session-a',
        projectId: 'project-1',
        title: 'Session A',
        agentActivityState: 'completed',
        primaryAgentTerminalId: 'terminal-1',
        attentionGeneration: 0,
        acknowledgedAttentionGeneration: 0,
        hasUnread: false,
        createdAt: STARTED_AT,
        updatedAt: STARTED_AT,
        ...overrides,
    } as SessionRecord;
}

interface Scenario {
    deselectedAt?: number;
    chatReadLeaseAt?: number;
    isChatSuspendable?: boolean;
    isChatMaintenancePending?: boolean;
    isObservedRemotely?: boolean;
    sample?: TerminalActivitySample;
    selectedSessionId?: string;
    session?: SessionRecord | undefined;
    settings?: Partial<TerminalSuspensionPolicyInput['settings']>;
    terminal?: TerminalRecord;
}

function decide(scenario: Scenario = {}) {
    const record = scenario.terminal ?? terminal();
    const sessionRecord = 'session' in scenario ? scenario.session : session();
    return decideTerminalSuspensions({
        chatReadLeaseAt: () => scenario.chatReadLeaseAt,
        deselectedAt: () => scenario.deselectedAt,
        isChatSuspendable: () => scenario.isChatSuspendable ?? false,
        isChatMaintenancePending: () => scenario.isChatMaintenancePending ?? false,
        isObservedRemotely: () => scenario.isObservedRemotely ?? false,
        now: NOW,
        sample: () => scenario.sample,
        visibleSessionIds: new Set([scenario.selectedSessionId ?? 'session-b']),
        session: () => sessionRecord,
        settings: {
            'terminal.idleSuspension.afterMinutes': 30,
            'terminal.idleSuspension.enabled': false,
            'terminal.suspendUntouchedAgents': true,
            ...scenario.settings,
        },
        startedAt: STARTED_AT,
        terminals: [record],
    });
}

const untouchedSample: TerminalActivitySample = {
    launchedAt: NOW - UNTOUCHED_SUSPENSION_DELAY_MS,
    turnInFlight: false,
};
const glancedAt = NOW - UNTOUCHED_SUSPENSION_DELAY_MS;

describe('decideTerminalSuspensions: untouched rule', () => {
    it('suspends an Agent that received no input and ran no turn since launch once the Session has been left', () => {
        expect(decide({ deselectedAt: glancedAt, sample: untouchedSample })).toEqual([
            { reason: 'untouched', terminalId: 'terminal-1' },
        ]);
    });

    it('waits until both the launch and the deselection are older than the grace delay', () => {
        expect(decide({ deselectedAt: glancedAt + 1, sample: untouchedSample })).toEqual([]);
        expect(
            decide({
                deselectedAt: glancedAt,
                sample: { ...untouchedSample, launchedAt: untouchedSample.launchedAt! + 1 },
            }),
        ).toEqual([]);
    });

    it('never touches the selected Session', () => {
        expect(
            decide({
                deselectedAt: glancedAt,
                sample: untouchedSample,
                selectedSessionId: 'session-a',
            }),
        ).toEqual([]);
    });

    it('leaves an Agent alone once the user typed into it or it started a turn', () => {
        expect(
            decide({
                deselectedAt: glancedAt,
                sample: { ...untouchedSample, lastInputAt: NOW - 5 },
            }),
        ).toEqual([]);
        expect(
            decide({
                deselectedAt: glancedAt,
                sample: {
                    ...untouchedSample,
                    lastTurnStartedAt: NOW - 5,
                    lastTurnFinishedAt: NOW - 1,
                },
            }),
        ).toEqual([]);
    });

    it('ignores launches this Server process never observed, since their input history is unknown', () => {
        expect(decide({ deselectedAt: glancedAt, sample: undefined })).toEqual([]);
        expect(
            decide({
                deselectedAt: glancedAt,
                sample: { turnInFlight: false, lastInputAt: undefined },
            }),
        ).toEqual([]);
    });

    it('protects a primary Agent that is running or waiting for the user, and any Agent mid-turn', () => {
        for (const agentActivityState of ['running', 'waiting'] as const)
            expect(
                decide({
                    deselectedAt: glancedAt,
                    sample: untouchedSample,
                    session: session({ agentActivityState }),
                }),
            ).toEqual([]);
        expect(
            decide({ deselectedAt: glancedAt, sample: { ...untouchedSample, turnInFlight: true } }),
        ).toEqual([]);
    });

    it('skips Shell tabs, exited or suspended Agents, archived Sessions, and Sessions that were never left', () => {
        expect(
            decide({
                deselectedAt: glancedAt,
                sample: untouchedSample,
                terminal: terminal({ kind: 'shell', provider: undefined }),
            }),
        ).toEqual([]);
        expect(
            decide({
                deselectedAt: glancedAt,
                sample: untouchedSample,
                terminal: terminal({ lastAgentProcessState: 'stopped' }),
            }),
        ).toEqual([]);
        expect(
            decide({
                deselectedAt: glancedAt,
                sample: untouchedSample,
                terminal: terminal({
                    lastProcessState: 'suspended',
                    lastAgentProcessState: 'suspended',
                }),
            }),
        ).toEqual([]);
        expect(
            decide({
                deselectedAt: glancedAt,
                sample: untouchedSample,
                session: session({ archivedAt: NOW - 1 }),
            }),
        ).toEqual([]);
        expect(
            decide({ deselectedAt: glancedAt, sample: untouchedSample, session: undefined }),
        ).toEqual([]);
        expect(decide({ deselectedAt: undefined, sample: untouchedSample })).toEqual([]);
    });

    it('is disabled by its setting', () => {
        expect(
            decide({
                deselectedAt: glancedAt,
                sample: untouchedSample,
                settings: { 'terminal.suspendUntouchedAgents': false },
            }),
        ).toEqual([]);
    });
});

describe('decideTerminalSuspensions: idle rule', () => {
    const halfHour = 30 * 60 * 1000;
    const idleOn = {
        'terminal.idleSuspension.afterMinutes': 30,
        'terminal.idleSuspension.enabled': true,
    } as const;
    const idleSample: TerminalActivitySample = {
        launchedAt: NOW - 3 * halfHour,
        lastInputAt: NOW - 2 * halfHour,
        lastTurnStartedAt: NOW - 2 * halfHour,
        lastTurnFinishedAt: NOW - halfHour,
        turnInFlight: false,
    };

    it('suspends a background Agent idle at its prompt for the configured delay', () => {
        expect(
            decide({
                deselectedAt: NOW - halfHour,
                sample: idleSample,
                settings: idleOn,
            }),
        ).toEqual([{ reason: 'idle', terminalId: 'terminal-1' }]);
        expect(
            decide({
                deselectedAt: NOW - halfHour,
                sample: idleSample,
                settings: { ...idleOn, 'terminal.idleSuspension.afterMinutes': 120 },
            }),
        ).toEqual([]);
    });

    it('parks an idle background Chat, on any provider, only when the Chat itself reports nothing pending', () => {
        const chat = (provider: TerminalRecord['provider']) =>
            terminal({ kind: provider, provider, surface: 'chat' });
        const idleChat = { deselectedAt: NOW - halfHour, sample: idleSample, settings: idleOn };

        expect(decide({ ...idleChat, terminal: chat('grok'), isChatSuspendable: true })).toEqual([
            { reason: 'idle', terminalId: 'terminal-1' },
        ]);
        expect(decide({ ...idleChat, terminal: chat('codex'), isChatSuspendable: false })).toEqual(
            [],
        );
        // The untouched rule judges launch and input samples a Chat never records.
        expect(
            decide({
                deselectedAt: NOW - UNTOUCHED_SUSPENSION_DELAY_MS,
                sample: untouchedSample,
                terminal: chat('codex'),
                isChatSuspendable: true,
            }),
        ).toEqual([]);
    });

    it('keeps an idle background Chat running while its idle compaction is pending', () => {
        const chat = terminal({ kind: 'claude', provider: 'claude', surface: 'chat' });
        const idleChat = {
            deselectedAt: NOW - halfHour,
            sample: idleSample,
            settings: idleOn,
            terminal: chat,
            isChatSuspendable: true,
        };

        expect(decide({ ...idleChat, isChatMaintenancePending: true })).toEqual([]);
        expect(decide({ ...idleChat, isChatMaintenancePending: false })).toEqual([
            { reason: 'idle', terminalId: 'terminal-1' },
        ]);
        // Only a Chat compacts; a PTY Agent's idle suspension is unchanged.
        expect(
            decide({
                deselectedAt: NOW - halfHour,
                sample: idleSample,
                settings: idleOn,
                isChatMaintenancePending: true,
            }),
        ).toEqual([{ reason: 'idle', terminalId: 'terminal-1' }]);
    });

    it('is off by default and honors any configured window, down to one minute', () => {
        expect(decide({ deselectedAt: NOW - 4 * halfHour, sample: idleSample })).toEqual([]);
        expect(
            idleSuspensionDelayMs({
                'terminal.idleSuspension.afterMinutes': 30,
                'terminal.idleSuspension.enabled': false,
                'terminal.suspendUntouchedAgents': true,
            }),
        ).toBeUndefined();
        const oneMinute = { ...idleOn, 'terminal.idleSuspension.afterMinutes': 1 };
        const recent: TerminalActivitySample = {
            launchedAt: NOW - halfHour,
            lastInputAt: NOW - 60_000,
            lastTurnStartedAt: NOW - 60_000,
            lastTurnFinishedAt: NOW - 60_000,
            turnInFlight: false,
        };
        expect(decide({ deselectedAt: NOW - 60_000, sample: recent, settings: oneMinute })).toEqual(
            [{ reason: 'idle', terminalId: 'terminal-1' }],
        );
        expect(
            decide({
                deselectedAt: NOW - 60_000,
                sample: { ...recent, lastTurnFinishedAt: NOW - 59_999 },
                settings: oneMinute,
            }),
        ).toEqual([]);
    });

    it('never parks an Agent waiting for a permission or an answer, even long after its turn ended', () => {
        expect(
            decide({
                deselectedAt: NOW - 4 * halfHour,
                sample: { ...idleSample, awaitingUser: true },
                settings: idleOn,
            }),
        ).toEqual([]);
    });

    it('counts any accepted lifecycle signal, including a subagent one, as activity', () => {
        expect(
            decide({
                deselectedAt: NOW - halfHour,
                sample: { ...idleSample, lastSignalAt: NOW - halfHour + 1 },
                settings: idleOn,
            }),
        ).toEqual([]);
    });

    it('never parks a Terminal a phone is observing', () => {
        expect(
            decide({
                deselectedAt: NOW - halfHour,
                isObservedRemotely: true,
                sample: idleSample,
                settings: idleOn,
            }),
        ).toEqual([]);
        expect(
            decide({
                deselectedAt: glancedAt,
                isObservedRemotely: true,
                sample: untouchedSample,
            }),
        ).toEqual([]);
    });

    it('counts the Server start as the last activity for launches it never observed', () => {
        expect(
            decide({
                deselectedAt: NOW - halfHour,
                sample: undefined,
                settings: idleOn,
            }),
        ).toEqual([{ reason: 'idle', terminalId: 'terminal-1' }]);
    });

    it('resets on recent input, turns, or a recent return to the Session', () => {
        expect(
            decide({
                deselectedAt: NOW - halfHour,
                sample: { ...idleSample, lastInputAt: NOW - halfHour + 1 },
                settings: idleOn,
            }),
        ).toEqual([]);
        expect(
            decide({
                deselectedAt: NOW - halfHour,
                sample: { ...idleSample, lastTurnFinishedAt: NOW - halfHour + 1 },
                settings: idleOn,
            }),
        ).toEqual([]);
        expect(
            decide({
                deselectedAt: NOW - halfHour + 1,
                sample: idleSample,
                settings: idleOn,
            }),
        ).toEqual([]);
    });

    it('prefers the untouched reason when both rules apply', () => {
        expect(
            decide({
                deselectedAt: NOW - halfHour,
                sample: { launchedAt: NOW - halfHour, turnInFlight: false },
                settings: idleOn,
            }),
        ).toEqual([{ reason: 'untouched', terminalId: 'terminal-1' }]);
    });
});

describe('decideTerminalSuspensions: Chat observation lease', () => {
    const chat = terminal({ kind: 'codex', provider: 'codex', surface: 'chat' });
    const leased = {
        terminal: chat,
        isChatSuspendable: true,
        chatReadLeaseAt: NOW - CHAT_OBSERVATION_LEASE_MS,
        deselectedAt: NOW - CHAT_OBSERVATION_LEASE_MS,
    };

    it('reclaims a provider that only a read started once its Session has been left, with idle suspension off', () => {
        expect(decide(leased)).toEqual([{ reason: 'observation', terminalId: 'terminal-1' }]);
    });

    it('counts the lease from the later of leaving the Session and the read', () => {
        expect(decide({ ...leased, chatReadLeaseAt: leased.chatReadLeaseAt + 1 })).toEqual([]);
        expect(decide({ ...leased, deselectedAt: leased.deselectedAt + 1 })).toEqual([]);
    });

    it('uses the read alone when the Session was never observed being left', () => {
        expect(decide({ ...leased, deselectedAt: undefined })).toEqual([
            { reason: 'observation', terminalId: 'terminal-1' },
        ]);
    });

    it('keeps a Chat that is selected, watched by a phone, busy, or no longer leased', () => {
        expect(decide({ ...leased, selectedSessionId: 'session-a' })).toEqual([]);
        expect(decide({ ...leased, isObservedRemotely: true })).toEqual([]);
        expect(decide({ ...leased, isChatSuspendable: false })).toEqual([]);
        expect(decide({ ...leased, chatReadLeaseAt: undefined })).toEqual([]);
    });

    it('reclaims an expired lease even while the idle compaction is pending', () => {
        expect(
            decide({
                ...leased,
                isChatMaintenancePending: true,
                settings: { 'terminal.idleSuspension.enabled': true },
            }),
        ).toEqual([{ reason: 'observation', terminalId: 'terminal-1' }]);
    });

    it('never applies a lease to a PTY Terminal', () => {
        expect(decide({ ...leased, terminal: terminal() })).toEqual([]);
    });

    it('reclaims the oldest unexpired read leases beyond the cap, so browsing many Chats keeps a bounded number', () => {
        const browsed = Array.from({ length: MAX_CHAT_OBSERVATION_LEASES + 2 }, (_, index) => ({
            leaseAt: NOW - (index + 1) * 1000,
            record: { ...chat, id: `chat-${index}` },
        }));
        const visible = {
            leaseAt: NOW - 60_000,
            record: { ...chat, id: 'chat-visible', sessionId: 'session-b' },
        };
        const leases = new Map(
            [...browsed, visible].map((entry) => [entry.record.id, entry.leaseAt]),
        );
        const decisions = decideTerminalSuspensions({
            chatReadLeaseAt: (terminalId) => leases.get(terminalId),
            deselectedAt: () => {},
            isChatSuspendable: () => true,
            isObservedRemotely: () => false,
            now: NOW,
            sample: () => {},
            visibleSessionIds: new Set(['session-b']),
            session: (sessionId) => session({ id: sessionId }),
            settings: {
                'terminal.idleSuspension.afterMinutes': 30,
                'terminal.idleSuspension.enabled': false,
                'terminal.suspendUntouchedAgents': true,
            },
            startedAt: STARTED_AT,
            terminals: [...browsed, visible].map(({ record }) => record),
        });
        // The two oldest browsed Chats go; the newest three and the visible Session's Chat stay.
        expect(decisions).toEqual([
            { reason: 'observation', terminalId: `chat-${MAX_CHAT_OBSERVATION_LEASES}` },
            { reason: 'observation', terminalId: `chat-${MAX_CHAT_OBSERVATION_LEASES + 1}` },
        ]);
    });
});
