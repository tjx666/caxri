import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    createAgentProviderStatus,
    createE2EStatusPageFetch,
    parseClaudeStatusPage,
    parseCodexStatusPage,
} from '../agent-provider-status';

function statuspageSummary(
    overrides: { apiStatus?: string; incidents?: unknown[] } = {},
): Record<string, unknown> {
    return {
        page: { name: 'Claude', url: 'https://status.example.test' },
        components: [
            { id: 'web', name: 'claude.ai', status: 'major_outage' },
            {
                id: 'api',
                name: 'Claude API (api.example.test)',
                status: overrides.apiStatus ?? 'operational',
            },
            { id: 'code', name: 'Claude Code', status: 'operational' },
        ],
        incidents: overrides.incidents ?? [],
    };
}

function incidentIoSummary(
    overrides: { affected?: unknown[]; incidents?: unknown[] } = {},
): Record<string, unknown> {
    return {
        summary: {
            name: 'OpenAI',
            public_url: 'https://status.example.test/',
            structure: {
                items: [
                    {
                        group: {
                            name: 'APIs',
                            components: [{ component_id: 'chat', name: 'Chat' }],
                        },
                    },
                    {
                        group: {
                            name: 'Codex',
                            components: [
                                { component_id: 'cx-web', name: 'Codex Web' },
                                { component_id: 'cx-cli', name: 'CLI' },
                                { component_id: 'cx-old', name: 'Retired', hidden: true },
                            ],
                        },
                    },
                ],
            },
            affected_components: overrides.affected ?? [],
            ongoing_incidents: overrides.incidents ?? [],
        },
    };
}

describe('parseClaudeStatusPage', () => {
    it('keeps only the API and Claude Code components and their incidents', () => {
        const page = parseClaudeStatusPage(
            statuspageSummary({
                apiStatus: 'partial_outage',
                incidents: [
                    {
                        id: 'i1',
                        name: 'Elevated API errors',
                        status: 'identified',
                        impact: 'major',
                        components: [{ id: 'api' }],
                        incident_updates: [
                            { body: 'A fix is rolling out.', updated_at: '2026-01-02T03:04:05Z' },
                        ],
                    },
                    {
                        id: 'i2',
                        name: 'Website down',
                        status: 'investigating',
                        components: [{ id: 'web' }],
                    },
                    {
                        id: 'i3',
                        name: 'Old incident',
                        status: 'resolved',
                        components: [{ id: 'api' }],
                    },
                ],
            }),
        );
        expect(page).toEqual({
            pageName: 'Claude',
            pageUrl: 'https://status.example.test',
            components: [
                { name: 'Claude API (api.example.test)', status: 'partialOutage' },
                { name: 'Claude Code', status: 'operational' },
            ],
            incidents: [
                {
                    name: 'Elevated API errors',
                    phase: 'identified',
                    status: 'partialOutage',
                    components: ['Claude API (api.example.test)'],
                    latestUpdate: 'A fix is rolling out.',
                    updatedAt: Date.parse('2026-01-02T03:04:05Z'),
                    url: 'https://status.example.test/incidents/i1',
                },
            ],
        });
    });

    it('falls back to the incident impact while components still read operational', () => {
        const page = parseClaudeStatusPage(
            statuspageSummary({
                incidents: [
                    {
                        id: 'i1',
                        name: 'Slow responses',
                        status: 'investigating',
                        impact: 'minor',
                        components: [{ id: 'code' }],
                    },
                ],
            }),
        );
        expect(page?.incidents[0]?.status).toBe('degraded');
    });

    it('rejects a page without the expected components', () => {
        expect(parseClaudeStatusPage({ ...statuspageSummary(), components: [] })).toBeUndefined();
        expect(parseClaudeStatusPage({ page: {} })).toBeUndefined();
    });
});

describe('parseCodexStatusPage', () => {
    it("reads the Codex group with each incident's newest update, treating unlisted components as operational", () => {
        const page = parseCodexStatusPage(
            incidentIoSummary({
                affected: [
                    { component_id: 'cx-cli', status: 'full_outage' },
                    { component_id: 'chat', status: 'degraded_performance' },
                ],
                incidents: [
                    {
                        id: 'o1',
                        name: 'Codex CLI failing',
                        status: 'monitoring',
                        affected_components: [{ component_id: 'cx-cli', status: 'full_outage' }],
                        updates: [
                            {
                                published_at: '2026-01-02T01:00:00Z',
                                message: { markdown: 'Investigating.' },
                            },
                            {
                                published_at: '2026-01-02T03:04:05Z',
                                message: { markdown: 'Monitoring the fix.' },
                            },
                        ],
                    },
                    {
                        id: 'o2',
                        name: 'Chat slow',
                        status: 'investigating',
                        affected_components: [
                            { component_id: 'chat', status: 'degraded_performance' },
                        ],
                    },
                ],
            }),
        );
        expect(page).toEqual({
            pageName: 'OpenAI',
            pageUrl: 'https://status.example.test',
            components: [
                { name: 'Codex Web', status: 'operational' },
                { name: 'CLI', status: 'majorOutage' },
            ],
            incidents: [
                {
                    name: 'Codex CLI failing',
                    phase: 'monitoring',
                    status: 'majorOutage',
                    components: ['CLI'],
                    latestUpdate: 'Monitoring the fix.',
                    updatedAt: Date.parse('2026-01-02T03:04:05Z'),
                    url: 'https://status.example.test/incidents/o1',
                },
            ],
        });
    });

    it('rejects a page that lost its Codex group', () => {
        const summary = incidentIoSummary();
        (summary.summary as { structure: { items: unknown[] } }).structure.items = [];
        expect(parseCodexStatusPage(summary)).toBeUndefined();
    });
});

function jsonResponse(body: unknown, status = 200): Promise<Response> {
    return Promise.resolve(Response.json(body, { status }));
}

describe('createAgentProviderStatus', () => {
    it('answers null for a provider without a status page and never fetches', async () => {
        const fetch = vi.fn(() => jsonResponse({}));
        const read = createAgentProviderStatus({ fetch });
        await expect(read('grok')).resolves.toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('summarizes the worst component status and shares one request within the TTL', async () => {
        let time = 1_000;
        const fetch = vi.fn(() =>
            jsonResponse(statuspageSummary({ apiStatus: 'degraded_performance' })),
        );
        const read = createAgentProviderStatus({ fetch, now: () => time });
        const [first, second] = await Promise.all([read('claude'), read('claude')]);
        expect(first).toMatchObject({
            provider: 'claude',
            state: 'available',
            status: 'degraded',
            checkedAt: 1_000,
        });
        expect(second).toBe(first);
        time += 59_000;
        await read('claude');
        expect(fetch).toHaveBeenCalledOnce();
        time += 2_000;
        await read('claude');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenCalledWith(
            'https://status.claude.com/api/v2/summary.json',
            expect.anything(),
        );
    });

    it.each([
        ['network', () => Promise.reject(new Error('offline'))],
        ['http', () => jsonResponse({}, 503)],
        ['invalidResponse', () => jsonResponse({ unexpected: true })],
    ] as const)(
        'reports a %s failure with the page link and logs it once',
        async (reason, fetch) => {
            const write = vi.fn();
            const read = createAgentProviderStatus({
                fetch,
                logger: () => ({ write }) as never,
                now: (() => {
                    let time = 0;
                    return () => (time += 31_000);
                })(),
            });
            await expect(read('codex')).resolves.toMatchObject({
                state: 'unavailable',
                reason,
                pageUrl: 'https://status.openai.com',
            });
            await read('codex');
            expect(write).toHaveBeenCalledOnce();
            expect(write).toHaveBeenCalledWith('warn', 'external_status.provider_status_failed', {
                fields: { provider: 'codex', reason },
            });
        },
    );

    it('records the recovery after a failure', async () => {
        const write = vi.fn();
        let isOnline = false;
        let time = 0;
        const read = createAgentProviderStatus({
            fetch: () =>
                isOnline ? jsonResponse(incidentIoSummary()) : Promise.reject(new Error('offline')),
            logger: () => ({ write }) as never,
            now: () => time,
        });
        await read('codex');
        isOnline = true;
        time += 31_000;
        await expect(read('codex')).resolves.toMatchObject({
            state: 'available',
            status: 'operational',
        });
        expect(write).toHaveBeenLastCalledWith(
            'info',
            'external_status.provider_status_recovered',
            {
                fields: { provider: 'codex', previousReason: 'network' },
            },
        );
    });
});

describe('createE2EStatusPageFetch', () => {
    it('answers from the fixture named after the host, and is offline without a directory', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-status-fixture-'));
        try {
            await writeFile(
                join(directory, 'status.claude.com.json'),
                JSON.stringify(statuspageSummary()),
            );
            const read = createAgentProviderStatus({ fetch: createE2EStatusPageFetch(directory) });
            await expect(read('claude')).resolves.toMatchObject({ state: 'available' });
            await expect(read('codex')).resolves.toMatchObject({
                state: 'unavailable',
                reason: 'network',
            });
            const offline = createAgentProviderStatus({
                fetch: createE2EStatusPageFetch(undefined),
            });
            await expect(offline('claude')).resolves.toMatchObject({ reason: 'network' });
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});
