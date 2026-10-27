// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type {
    AgentProviderStatus,
    AgentThroughput,
    Principal,
    SessionQueryResult,
    TerminalQueryResult,
    UsageLimit,
} from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import {
    createMobileAgentUsageRequests,
    mobileServiceStatus,
    throughputSources,
} from '../agent-usage-requests';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';

type Session = SessionQueryResult['sessions'][number];
type Terminal = TerminalQueryResult['terminals'][number];

const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'view',
    projectIds: ['project-1'],
};

const session = (id: string, overrides: Partial<Session> = {}): Session =>
    ({
        id,
        projectId: 'project-1',
        title: `Session ${id}`,
        lastVisitedAt: 0,
        sessionActivityAt: 0,
        ...overrides,
    }) as Session;

const terminal = (id: string, sessionId: string, kind: Terminal['kind']): Terminal => ({
    id,
    sessionId,
    kind,
    title: id,
    lastProcessState: 'running',
});

const throughput = (overrides: Partial<AgentThroughput> = {}): AgentThroughput => ({
    provider: 'claude',
    recent: { outputTokens: 4_200, durationMs: 100_000, responseCount: 3 },
    turn: { outputTokens: 0, durationMs: 0, responseCount: 0 },
    session: { outputTokens: 4_200, durationMs: 100_000, responseCount: 3 },
    byModel: [],
    samples: [{ outputTokens: 1_400, durationMs: 30_000, completedAt: 5_000, model: 'claude-x' }],
    ...overrides,
});

const fiveHourLimit: UsageLimit = {
    provider: 'claude',
    observedAt: 1_000,
    windows: [{ windowMinutes: 300, usedPercent: 38, resetsAt: 9_000, scope: 'session' }],
};

const statusPage = (overrides: { incidents?: number; update?: string } = {}) =>
    JSON.stringify({
        page: { name: 'Claude', url: 'https://status.example.test' },
        components: [
            { id: 'api', name: 'Claude API (api.anthropic.com)', status: 'degraded_performance' },
            { id: 'code', name: 'Claude Code', status: 'operational' },
        ],
        incidents: Array.from({ length: overrides.incidents ?? 1 }, (_, index) => ({
            id: `incident-${index}`,
            name: `Elevated errors ${index}`,
            status: 'investigating',
            impact: 'minor',
            shortlink: `https://stspg.example.test/${index}`,
            components: [{ id: 'api' }],
            incident_updates: [
                {
                    body: overrides.update ?? 'Investigating',
                    updated_at: '2026-10-27T00:00:00Z',
                },
            ],
        })),
    });

function domainFixture(input: {
    sessions: Session[];
    terminals: Terminal[];
    throughputByTerminal?: Record<string, AgentThroughput | null>;
    limits?: UsageLimit[];
}) {
    const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(
        async (method, parameters) => {
            if (method === 'session.queryForPrincipal') return { sessions: input.sessions };
            if (method === 'terminal.queryForPrincipal') return { terminals: input.terminals };
            if (method === 'terminal.agentThroughput') {
                const { terminalId } = parameters as { terminalId: string };
                return input.throughputByTerminal?.[terminalId] ?? null;
            }
            if (method === 'terminal.agentUsage') return null;
            if (method === 'usage.limits') return input.limits ?? [];
            throw new Error(`Unexpected ${method}`);
        },
    );
    return { domainService: { request } as unknown as ServerDomainService, request };
}

const offlineFetch = vi.fn(async () => {
    throw new Error('offline');
});

describe('mobile Agent usage requests', () => {
    it('is readable by every paired role', () => {
        for (const role of ['view', 'reply', 'control'] as const)
            expect(isMobileGatewayMethodAllowedForRole(role, 'mobile.agentUsage.read')).toBe(true);
    });

    it("takes speed from the provider's most recently active Session, its primary Agent first", () => {
        const sources = throughputSources({
            provider: 'claude',
            sessions: [
                session('old', { sessionActivityAt: 10 }),
                session('new', {
                    sessionActivityAt: 20,
                    primaryAgentTerminalId: 'new-primary',
                }),
                session('archived', { sessionActivityAt: 30, archivedAt: 31 }),
                session('other-project', { sessionActivityAt: 40, projectId: 'project-2' }),
            ],
            terminals: [
                terminal('old-claude', 'old', 'claude'),
                terminal('new-helper', 'new', 'claude'),
                terminal('new-primary', 'new', 'claude'),
                terminal('new-codex', 'new', 'codex'),
                terminal('archived-claude', 'archived', 'claude'),
                terminal('other-claude', 'other-project', 'claude'),
            ],
            grantedProjectIds: new Set(['project-1']),
        });
        expect(sources.map((source) => source.terminalId)).toEqual([
            'new-primary',
            'new-helper',
            'old-claude',
        ]);
    });

    it('drops uptime history and clips incidents for the phone', () => {
        const status: AgentProviderStatus = {
            provider: 'codex',
            pageName: 'OpenAI',
            pageUrl: 'https://status.example.test',
            checkedAt: 1,
            state: 'available',
            status: 'degraded',
            components: [
                {
                    name: 'Codex',
                    status: 'degraded',
                    uptime: { windowStart: 0, windowEnd: 1, impacts: [] },
                },
            ],
            incidents: Array.from({ length: 6 }, (_, index) => ({
                name: `Incident ${index}`,
                phase: 'investigating',
                status: 'degraded' as const,
                components: ['Codex'],
                latestUpdate: 'x'.repeat(1_000),
                url: 'https://status.example.test/incident',
            })),
        };
        const projected = mobileServiceStatus(status);
        expect(projected.state === 'available' && projected.components).toEqual([
            { name: 'Codex', status: 'degraded' },
        ]);
        expect(projected.state === 'available' && projected.incidents).toHaveLength(4);
        expect(
            projected.state === 'available' && projected.incidents[0]?.latestUpdate,
        ).toHaveLength(600);
    });

    it('answers limits, speed, and status per Agent, falling back to an older Agent with a measured speed', async () => {
        const domain = domainFixture({
            sessions: [
                session('a', { sessionActivityAt: 20, title: 'Fix login' }),
                session('b', { sessionActivityAt: 10, title: 'Docs' }),
            ],
            terminals: [terminal('a-claude', 'a', 'claude'), terminal('b-claude', 'b', 'claude')],
            throughputByTerminal: { 'a-claude': null, 'b-claude': throughput() },
            limits: [fiveHourLimit],
        });
        const read = createMobileAgentUsageRequests({
            fetch: async (url) => {
                if (url.includes('status.claude.com'))
                    return new Response(statusPage({ incidents: 1 }));
                throw new Error('offline');
            },
        });
        const result = await read(domain.domainService, principal);
        expect(result.providers.map((entry) => entry.provider)).toEqual(['claude', 'codex']);
        const [claude, codex] = result.providers;
        expect(claude.limit).toEqual(fiveHourLimit);
        expect(claude.throughput).toEqual({
            outputTokens: 4_200,
            durationMs: 100_000,
            responseCount: 3,
            lastResponseAt: 5_000,
            model: 'claude-x',
            sessionId: 'b',
            sessionTitle: 'Docs',
        });
        expect(claude.serviceStatus).toMatchObject({ state: 'available', status: 'degraded' });
        // Reading the newest Claude Agent is what asks its running Chat for a fresh plan reading.
        expect(domain.request).toHaveBeenCalledWith('terminal.agentUsage', {
            terminalId: 'a-claude',
        });
        expect(codex).toMatchObject({
            provider: 'codex',
            serviceStatus: { state: 'unavailable', reason: 'network' },
        });
        expect(codex.limit).toBeUndefined();
        expect(codex.throughput).toBeUndefined();
    });

    it('lists another provider once it reports a plan limit', async () => {
        const domain = domainFixture({
            sessions: [],
            terminals: [],
            limits: [{ provider: 'grok', observedAt: 1, windows: [] }],
        });
        const read = createMobileAgentUsageRequests({ fetch: offlineFetch });
        const result = await read(domain.domainService, principal);
        expect(result.providers.map((entry) => entry.provider)).toEqual([
            'claude',
            'codex',
            'grok',
        ]);
        expect(result.providers[2]).toEqual({
            provider: 'grok',
            limit: { provider: 'grok', observedAt: 1, windows: [] },
        });
    });
});
