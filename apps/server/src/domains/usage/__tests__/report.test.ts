import type { ProjectRecord, SessionRecord, UsageReportParameters } from '@caxri/protocol';
import { usageReportParametersSchema, usageReportSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentSessionUsageRow, ExternalAgentUsageRow, PullRequestOutcomeRow } from '../../db';
import { LocalClock } from '../local-clock';
import type { ModelPrice } from '../pricing';
import type { UsageRecord } from '../record';
import type { UsageReportInput } from '../report';
import { buildUsageReport, DELETED_SESSION_TITLE, OUTSIDE_CAXRI_TITLE } from '../report';

/**
 * 2026-03-10 12:00 in Shanghai (UTC+8).
 */
const NOW = Date.parse('2026-03-10T04:00:00.000Z');
const HOUR = 3_600_000;
const PRICE: ModelPrice = [1e-6, 2e-6, 1e-7, null, null];
const PR_URL = 'https://github.com/acme/widgets/pull/7';

function row(overrides: Partial<AgentSessionUsageRow>): AgentSessionUsageRow {
    return {
        provider: 'claude',
        agentSessionId: 'agent-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        terminalId: 'terminal-1',
        cwd: '/work',
        boundAt: NOW,
        sourceFingerprint: null,
        scannedAt: null,
        usageJson: null,
        ...overrides,
    };
}

function outsideRow(overrides: Partial<ExternalAgentUsageRow>): ExternalAgentUsageRow {
    return {
        provider: 'claude',
        transcriptId: 'outside-1',
        agentSessionId: 'outside-1',
        path: '/transcripts/outside-1.jsonl',
        cwd: '/work/widgets/src',
        sourceFingerprint: 'v1|1:1',
        scannedAt: NOW,
        usageJson: '{}',
        ...overrides,
    };
}

function usage(at: number, input: number, overrides: Partial<UsageRecord> = {}): UsageRecord {
    const hour = Math.floor(at / HOUR) * 3600;
    return {
        version: 2,
        models: ['claude-x'],
        tokens: [[hour, 0, input, 0, 0, 0, 0, 0, 0]],
        activity: [[hour, 60_000]],
        pullRequests: [],
        ...overrides,
    };
}

const project = {
    id: 'project-1',
    rootPath: '/work/widgets',
    title: 'Widgets',
} as ProjectRecord;
const worktree = {
    id: 'project-2',
    rootPath: '/work/widgets-worktrees/fix',
    title: 'widgets-worktree',
    ownerProjectId: 'project-1',
} as ProjectRecord;
const session = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Fix login',
    createdAt: NOW - 2 * 24 * HOUR,
    archivedAt: NOW - HOUR,
} as SessionRecord;

function report(
    overrides: Omit<Partial<UsageReportInput>, 'params'> & {
        params?: Partial<UsageReportParameters>;
    },
) {
    return buildUsageReport({
        now: NOW,
        entries: [],
        sessions: [session],
        projects: [project, worktree],
        pullRequests: [],
        priceOf: (model) => (model === 'claude-x' ? PRICE : undefined),
        pricing: { source: 'bundled' },
        ...overrides,
        params: { timeZone: 'Asia/Shanghai', range: '30d', ...overrides.params },
    });
}

describe('LocalClock', () => {
    it('maps instants to the local date and hour', () => {
        expect(new LocalClock('Asia/Shanghai').at(Date.parse('2026-03-09T16:30:00Z'))).toEqual({
            date: '2026-03-10',
            hour: 0,
        });
    });

    it('rejects an unknown time zone', () => {
        expect(() => new LocalClock('Mars/Olympus')).toThrow('Unknown time zone');
    });
});

describe('buildUsageReport', () => {
    it('prices tokens, buckets by local day, and conforms to the protocol schema', () => {
        const result = report({ entries: [{ row: row({}), record: usage(NOW, 1_000_000) }] });

        expect(usageReportSchema.parse(result)).toEqual(result);
        expect(result.today).toBe('2026-03-10');
        expect(result.rangeStart).toBe('2026-02-09');
        expect(result.totals.costUsd).toBeCloseTo(1);
        expect(result.totals.tokens.total).toBe(1_000_000);
        expect(result.windows.today.tokens).toBe(1_000_000);
        expect(result.activity).toEqual([
            { date: '2026-03-10', tokens: 1_000_000, costUsd: 1, activeMs: 60_000 },
        ]);
        expect(result.hourOfDay[12]).toBe(1_000_000);
        expect(result.totals.sessionsCreated).toBe(1);
        expect(result.totals.sessionsArchived).toBe(1);
    });

    it('keeps out-of-range usage in the heatmap but not in the range totals', () => {
        const old = NOW - 60 * 24 * HOUR;
        const result = report({ entries: [{ row: row({}), record: usage(old, 500) }] });

        expect(result.totals.tokens.total).toBe(0);
        expect(result.activity.map((day) => day.tokens)).toEqual([500]);
        expect(
            report({
                entries: [{ row: row({}), record: usage(old, 500) }],
                params: { range: 'all' },
            }).totals.tokens.total,
        ).toBe(500);
    });

    it('counts only today for the today range', () => {
        const result = report({
            entries: [
                { row: row({}), record: usage(NOW, 10) },
                { row: row({ agentSessionId: 'agent-2' }), record: usage(NOW - 24 * HOUR, 20) },
            ],
            params: { range: 'today' },
        });

        expect(result.rangeStart).toBe('2026-03-10');
        expect(result.rangeEnd).toBeUndefined();
        expect(result.totals.tokens.total).toBe(10);
    });

    it('bounds a custom range on both ends and treats an end past today as today', () => {
        const entries = [
            { row: row({}), record: usage(NOW, 1) },
            { row: row({ agentSessionId: 'agent-2' }), record: usage(NOW - 24 * HOUR, 10) },
            { row: row({ agentSessionId: 'agent-3' }), record: usage(NOW - 3 * 24 * HOUR, 100) },
        ];
        const past = report({
            entries,
            params: { range: 'custom', start: '2026-03-07', end: '2026-03-09' },
        });

        expect(usageReportSchema.parse(past)).toEqual(past);
        expect(past.rangeStart).toBe('2026-03-07');
        expect(past.rangeEnd).toBe('2026-03-09');
        expect(past.totals.tokens.total).toBe(110);
        expect(past.windows.today.tokens).toBe(1);

        const throughFuture = report({
            entries,
            params: { range: 'custom', start: '2026-03-09', end: '2026-04-01' },
        });
        expect(throughFuture.rangeEnd).toBeUndefined();
        expect(throughFuture.totals.tokens.total).toBe(11);
    });

    it('rejects a custom range without ordered dates and dates on a preset', () => {
        const base = { timeZone: 'Asia/Shanghai' };
        expect(usageReportParametersSchema.safeParse({ ...base, range: 'custom' }).success).toBe(
            false,
        );
        expect(
            usageReportParametersSchema.safeParse({
                ...base,
                range: 'custom',
                start: '2026-03-09',
                end: '2026-03-07',
            }).success,
        ).toBe(false);
        expect(
            usageReportParametersSchema.safeParse({ ...base, range: '7d', start: '2026-03-09' })
                .success,
        ).toBe(false);
    });

    it('groups a linked worktree under its owning Project and keeps deleted Sessions', () => {
        const result = report({
            entries: [
                { row: row({ sessionId: 'gone', projectId: 'project-2' }), record: usage(NOW, 10) },
                { row: row({ agentSessionId: 'agent-2' }), record: usage(NOW, 20) },
            ],
        });

        expect(result.projects).toHaveLength(1);
        expect(result.projects[0]).toMatchObject({
            projectId: 'project-1',
            title: 'Widgets',
            tokens: 30,
            sessions: 2,
        });
        expect(result.sessions.find((item) => item.sessionId === 'gone')).toMatchObject({
            title: DELETED_SESSION_TITLE,
            isDeleted: true,
        });
    });

    it('counts usage stamped in the future as today', () => {
        const result = report({
            entries: [{ row: row({}), record: usage(NOW + 400 * 24 * HOUR, 7) }],
        });

        expect(usageReportSchema.parse(result)).toEqual(result);
        expect(result.activity.map((day) => day.date)).toEqual(['2026-03-10']);
        expect(result.windows.today.tokens).toBe(7);
    });

    it('reports unpriced models and filters by provider', () => {
        const record = usage(NOW, 10, { models: ['mystery'] });
        const entries = [
            { row: row({}), record },
            { row: row({ provider: 'codex', agentSessionId: 'agent-2' }), record: usage(NOW, 5) },
        ];

        expect(report({ entries }).coverage.unpricedModels).toEqual(['mystery']);
        const codex = report({ entries, params: { provider: 'codex' } });
        expect(codex.totals.tokens.total).toBe(5);
        expect(codex.providers.map((item) => item.provider)).toEqual(['codex']);
    });

    it('narrows the report to one Session and leaves out conversations run outside Caxri', () => {
        const other = { ...session, id: 'session-2', archivedAt: undefined } as SessionRecord;
        const result = report({
            sessions: [session, other],
            entries: [
                { row: row({}), record: usage(NOW, 10) },
                {
                    row: row({ sessionId: 'session-2', agentSessionId: 'agent-2' }),
                    record: usage(NOW, 20),
                },
            ],
            outside: {
                pendingScans: 0,
                entries: [{ row: outsideRow({}), record: usage(NOW, 40) }],
            },
            params: { scope: 'all', sessionId: 'session-2' },
        });

        expect(usageReportSchema.parse(result)).toEqual(result);
        expect(result.sessionId).toBe('session-2');
        expect(result.totals.tokens.total).toBe(20);
        expect(result.totals).toMatchObject({
            sessionsCreated: 1,
            sessionsArchived: 0,
            sessionsWithUsage: 1,
            outsideSessionsWithUsage: 0,
        });
        expect(result.sessions.map((item) => item.sessionId)).toEqual(['session-2']);
        expect(result.coverage.agentSessions).toBe(1);
    });

    it('includes a conversation resumed in the filtered Session without moving its owner', () => {
        const other = { ...session, id: 'session-2', archivedAt: undefined } as SessionRecord;
        const entries = [
            { row: row({}), record: usage(NOW, 10) },
            {
                row: row({ sessionId: 'session-2', agentSessionId: 'agent-2' }),
                record: usage(NOW, 20),
            },
        ];
        const boundAgentSessions = (sessionId: string) =>
            sessionId === 'session-2' ? ['claude:agent-1'] : [];

        const resumedIn = report({
            sessions: [session, other],
            entries,
            boundAgentSessions,
            params: { sessionId: 'session-2' },
        });
        expect(usageReportSchema.parse(resumedIn)).toEqual(resumedIn);
        expect(resumedIn.totals.tokens.total).toBe(30);
        expect(resumedIn.totals.sessionsCreated).toBe(1);
        expect(resumedIn.sessions.map(({ sessionId, tokens }) => ({ sessionId, tokens }))).toEqual([
            { sessionId: 'session-2', tokens: 20 },
            { sessionId: 'session-1', tokens: 10 },
        ]);

        const owner = report({
            sessions: [session, other],
            entries,
            boundAgentSessions,
            params: { sessionId: 'session-1' },
        });
        expect(owner.totals.tokens.total).toBe(10);

        const unfiltered = report({ sessions: [session, other], entries, boundAgentSessions });
        expect(unfiltered.totals.tokens.total).toBe(30);
        expect(unfiltered.sessions.find((item) => item.sessionId === 'session-1')?.tokens).toBe(10);
    });

    it('counts merged pull requests once and leaves unfetched ones pending', () => {
        const outcome: PullRequestOutcomeRow = {
            url: PR_URL,
            state: 'merged',
            title: 'Add widgets',
            openedAt: NOW - 2 * HOUR,
            mergedAt: NOW - HOUR,
            additions: 12,
            deletions: 3,
            checkedAt: NOW,
        };
        const withPullRequest = usage(NOW, 1, { pullRequests: [PR_URL] });
        const entries = [
            { row: row({}), record: withPullRequest },
            { row: row({ agentSessionId: 'agent-2' }), record: withPullRequest },
        ];

        expect(report({ entries }).coverage.pendingPullRequests).toBe(1);
        const result = report({ entries, pullRequests: [outcome] });
        expect(result.totals).toMatchObject({
            pullRequestsCreated: 1,
            pullRequestsMerged: 1,
            linesAdded: 12,
            linesDeleted: 3,
        });
        expect(result.pullRequests).toEqual([
            expect.objectContaining({
                number: 7,
                repository: 'acme/widgets',
                sessionId: 'session-1',
            }),
        ]);
        expect(result.projects[0].pullRequestsMerged).toBe(1);
    });

    it('adds Agent Sessions run outside Caxri for the all scope without double counting', () => {
        const entries = [{ row: row({}), record: usage(NOW, 100) }];
        const caxri = report({ entries });
        expect(caxri.scope).toBe('caxri');
        expect(caxri.coverage.outsideCaxri).toBeUndefined();

        const result = report({
            entries,
            outside: {
                pendingScans: 3,
                entries: [
                    // Inside a linked worktree: rolls up into the owning Project.
                    {
                        row: outsideRow({ cwd: '/work/widgets-worktrees/fix/lib' }),
                        record: usage(NOW, 10),
                    },
                    // Two files of one reverted Codex thread are one Agent Session.
                    {
                        row: outsideRow({
                            provider: 'codex',
                            transcriptId: 'thread-1',
                            agentSessionId: 'thread-1',
                            cwd: '/tmp/scratch',
                        }),
                        record: usage(NOW, 20),
                    },
                    {
                        row: outsideRow({
                            provider: 'codex',
                            transcriptId: 'rollout-2',
                            agentSessionId: 'thread-1',
                            cwd: '/tmp/scratch',
                        }),
                        record: usage(NOW, 30),
                    },
                    // Already in the ledger: counted once, from the ledger.
                    {
                        row: outsideRow({ transcriptId: 'agent-1', agentSessionId: 'agent-1' }),
                        record: usage(NOW, 1_000),
                    },
                ],
            },
        });

        expect(usageReportSchema.parse(result)).toEqual(result);
        expect(result.scope).toBe('all');
        expect(result.totals.tokens.total).toBe(160);
        expect(result.totals).toMatchObject({ sessionsWithUsage: 1, outsideSessionsWithUsage: 2 });
        expect(result.coverage.outsideCaxri).toEqual({ agentSessions: 2, pendingScans: 3 });
        expect(result.projects).toEqual([
            expect.objectContaining({
                projectId: 'project-1',
                tokens: 110,
                sessions: 2,
                isOutsideCaxri: false,
            }),
            expect.objectContaining({
                title: OUTSIDE_CAXRI_TITLE,
                tokens: 50,
                sessions: 1,
                isOutsideCaxri: true,
                isRemoved: false,
            }),
        ]);
        expect(result.sessions.find((item) => item.tokens === 50)).toMatchObject({
            title: 'scratch',
            projectTitle: OUTSIDE_CAXRI_TITLE,
            isOutsideCaxri: true,
            isDeleted: false,
            providers: ['codex'],
        });
        expect(result.providers.find((item) => item.provider === 'claude')?.sessions).toBe(2);
    });
});
