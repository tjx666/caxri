import type { AgentProviderStatus, MobileAgentUsageProvider } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentUsageCards,
    agentUsageScreenState,
    resetClockTime,
    throughputRateLabel,
} from '../agent-usage-model';

const NOW = new Date(2026, 9, 19, 12, 0).getTime();
const HOUR = 3_600_000;

const degradedClaude: AgentProviderStatus = {
    provider: 'claude',
    pageName: 'Claude',
    pageUrl: 'https://status.example.test',
    checkedAt: NOW - 60_000,
    state: 'available',
    status: 'degraded',
    components: [
        { name: 'Claude API', status: 'degraded' },
        { name: 'Claude Code', status: 'degraded' },
        { name: 'claude.ai', status: 'operational' },
    ],
    incidents: [
        {
            name: 'Elevated errors',
            phase: 'investigating',
            status: 'degraded',
            components: ['Claude API'],
            latestUpdate: 'We are looking into it.',
            url: 'https://status.example.test/incidents/1',
        },
    ],
};

describe('resetClockTime', () => {
    it('names only the clock time today and adds the weekday on a later day', () => {
        expect(resetClockTime(NOW + 2 * HOUR + 30 * 60_000, NOW, 'en')).toBe('14:30');
        expect(resetClockTime(NOW + 3 * 24 * HOUR, NOW, 'en')).toBe('Thu 12:00');
    });
});

describe('throughputRateLabel', () => {
    it('rounds to whole tokens per second and skips a duration too short to divide by', () => {
        expect(throughputRateLabel({ outputTokens: 4_200, durationMs: 68_000 })).toBe(
            '62\u{A0}tok/s',
        );
        expect(throughputRateLabel({ outputTokens: 1, durationMs: 10_000 })).toBe('<1\u{A0}tok/s');
        expect(throughputRateLabel({ outputTokens: 900, durationMs: 100 })).toBeUndefined();
        expect(throughputRateLabel({ outputTokens: 0, durationMs: 5_000 })).toBeUndefined();
    });
});

describe('agentUsageCards', () => {
    it('shows each limit with its reset time, the speed source, and the affected components', () => {
        const providers: MobileAgentUsageProvider[] = [
            {
                provider: 'claude',
                limit: {
                    provider: 'claude',
                    observedAt: NOW - 5 * 60_000,
                    windows: [
                        {
                            windowMinutes: 300,
                            usedPercent: 38,
                            resetsAt: NOW + 2 * HOUR + 30 * 60_000,
                        },
                    ],
                },
                throughput: {
                    outputTokens: 4_200,
                    durationMs: 68_000,
                    responseCount: 3,
                    lastResponseAt: NOW - 2 * 60_000,
                    sessionId: 'session-1',
                    sessionTitle: 'Fix login',
                },
                serviceStatus: degradedClaude,
            },
        ];
        const [card] = agentUsageCards(providers, NOW, 'en');
        expect(card).toMatchObject({
            provider: 'claude',
            name: 'Claude',
            limits: [
                {
                    label: '5-hour limit',
                    left: '62% left',
                    resetLabel: 'Resets in 2h 30m · 14:30',
                },
            ],
            pace: undefined,
            speed: { rate: '62\u{A0}tok/s' },
            service: {
                label: 'Degraded performance',
                tone: 'warning',
                affected: ['Degraded performance: Claude API, Claude Code'],
                incidents: [
                    {
                        name: 'Elevated errors',
                        detail: 'Degraded performance · Investigating',
                        latestUpdate: 'We are looking into it.',
                    },
                ],
                pageUrl: 'https://status.example.test',
            },
        });
        expect(card.limitNote).toMatch(/^Updated /);
        expect(card.speed?.source).toMatch(/^Last 3 responses in Fix login · /);
        expect(card.service?.note).toMatch(/^Checked /);
    });

    it('explains a missing reading and an unreachable status page', () => {
        const [claude, codex] = agentUsageCards(
            [
                { provider: 'claude' },
                {
                    provider: 'codex',
                    serviceStatus: {
                        provider: 'codex',
                        pageName: 'OpenAI',
                        pageUrl: 'https://status.example.test',
                        checkedAt: NOW,
                        state: 'unavailable',
                        reason: 'network',
                    },
                },
            ],
            NOW,
            'en',
        );
        expect(claude).toMatchObject({
            limits: [],
            speed: undefined,
            service: undefined,
        });
        expect(claude.limitNote).toMatch(/Claude Code reports one only while/);
        expect(codex.limitNote).toMatch(/Codex reports one while it runs/);
        expect(codex).toMatchObject({
            service: {
                label: 'Unknown',
                tone: 'muted',
                note: 'Status unavailable: the computer could not reach the status page',
            },
        });
    });
});

describe('agentUsageScreenState', () => {
    it('reads offline, not loading, when the disabled query has no data', () => {
        expect(
            agentUsageScreenState({ hasData: false, isError: false, isObservable: false }),
        ).toEqual({ kind: 'offline' });
    });

    it('loads only while the phone can observe the computer', () => {
        expect(
            agentUsageScreenState({ hasData: false, isError: false, isObservable: true }),
        ).toEqual({ kind: 'loading' });
        expect(
            agentUsageScreenState({ hasData: false, isError: true, isObservable: true }),
        ).toEqual({ kind: 'error' });
    });

    it('keeps a reading on screen and marks it stale once the phone goes offline', () => {
        expect(
            agentUsageScreenState({ hasData: true, isError: false, isObservable: false }),
        ).toEqual({ kind: 'ready', isStale: true });
        expect(agentUsageScreenState({ hasData: true, isError: true, isObservable: true })).toEqual(
            { kind: 'ready', isStale: false },
        );
    });
});
