import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { TerminalActivitySample, TerminalSuspensionPolicyInput } from '../suspension-policy';
import {
    decideTerminalSuspensions,
    idleSuspensionDelayMs,
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
        icon: 'claude',
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
        lastActivityState: 'completed',
        primaryAgentTerminalId: 'terminal-1',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        createdAt: STARTED_AT,
        updatedAt: STARTED_AT,
        ...overrides,
    } as SessionRecord;
}

interface Scenario {
    deselectedAt?: number;
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
        deselectedAt: () => scenario.deselectedAt,
        isObservedRemotely: () => scenario.isObservedRemotely ?? false,
        now: NOW,
        sample: () => scenario.sample,
        selectedSessionId: scenario.selectedSessionId ?? 'session-b',
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
        for (const lastActivityState of ['running', 'waiting'] as const)
            expect(
                decide({
                    deselectedAt: glancedAt,
                    sample: untouchedSample,
                    session: session({ lastActivityState }),
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
