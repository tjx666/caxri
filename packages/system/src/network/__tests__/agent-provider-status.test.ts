import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createAgentProviderStatus, createE2EStatusPageFetch } from '../agent-provider-status.js';
import {
    parseClaudeStatusPage,
    parseCodexStatusPage,
    parseIncidentIoHistory,
} from '../agent-provider-status-parsers.js';

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
                                { component_id: 'cx-api', name: 'Codex API' },
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
    it("reads only the Codex API component with each incident's newest update", () => {
        const page = parseCodexStatusPage(
            incidentIoSummary({
                affected: [
                    { component_id: 'cx-api', status: 'full_outage' },
                    { component_id: 'cx-web', status: 'full_outage' },
                    { component_id: 'chat', status: 'degraded_performance' },
                ],
                incidents: [
                    {
                        id: 'o1',
                        name: 'Codex API failing',
                        status: 'monitoring',
                        affected_components: [
                            { component_id: 'cx-api', status: 'full_outage' },
                            { component_id: 'cx-web', status: 'full_outage' },
                        ],
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
                        id: 'o3',
                        name: 'Codex Web down',
                        status: 'investigating',
                        affected_components: [{ component_id: 'cx-web', status: 'full_outage' }],
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
            components: [{ name: 'Codex API', status: 'majorOutage' }],
            componentIds: new Map([['Codex API', 'cx-api']]),
            incidents: [
                {
                    name: 'Codex API failing',
                    phase: 'monitoring',
                    status: 'majorOutage',
                    components: ['Codex API'],
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

describe('parseIncidentIoHistory', () => {
    it("keeps the component's uptime and impact intervals, open ones without an end", () => {
        const window = { start: 1_000, end: 9_000 };
        expect(
            parseIncidentIoHistory(
                {
                    component_impacts: [
                        {
                            component_id: 'cx-api',
                            start_at: '2026-01-02T00:00:00Z',
                            end_at: '2026-01-02T01:00:00Z',
                            status: 'degraded_performance',
                        },
                        {
                            component_id: 'cx-api',
                            start_at: '2026-01-03T00:00:00Z',
                            end_at: null,
                            status: 'full_outage',
                        },
                        {
                            component_id: 'cx-web',
                            start_at: '2026-01-02T00:00:00Z',
                            status: 'partial_outage',
                        },
                    ],
                    component_uptimes: [
                        {
                            component_id: 'cx-api',
                            uptime: '99.95',
                            data_available_since: '2025-12-01T00:00:00Z',
                        },
                        { component_id: 'cx-web', uptime: '98.00' },
                    ],
                },
                'cx-api',
                window,
            ),
        ).toEqual({
            windowStart: 1_000,
            windowEnd: 9_000,
            percent: 99.95,
            dataAvailableSince: Date.parse('2025-12-01T00:00:00Z'),
            impacts: [
                {
                    startAt: Date.parse('2026-01-02T00:00:00Z'),
                    endAt: Date.parse('2026-01-02T01:00:00Z'),
                    status: 'degraded',
                },
                { startAt: Date.parse('2026-01-03T00:00:00Z'), status: 'majorOutage' },
            ],
        });
    });

    it('skips group-level rows, which carry a group id instead of a component id', () => {
        expect(
            parseIncidentIoHistory(
                {
                    component_impacts: [
                        {
                            status_page_component_group_id: 'cx-group',
                            start_at: '2026-01-02T00:00:00Z',
                            status: 'partial_outage',
                        },
                    ],
                    component_uptimes: [
                        { status_page_component_group_id: 'cx-group', uptime: '99.00' },
                        { component_id: 'cx-api', uptime: '99.95' },
                    ],
                },
                'cx-api',
                { start: 0, end: 1 },
            ),
        ).toEqual({ windowStart: 0, windowEnd: 1, percent: 99.95, impacts: [] });
    });

    it('rejects a body without impacts', () => {
        expect(parseIncidentIoHistory({}, 'cx-api', { start: 0, end: 1 })).toBeUndefined();
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
                logger: () => ({ write }),
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

    it('stops reading an oversize status page and reports it as invalid', async () => {
        let pulls = 0;
        let isCancelled = false;
        const page = new TextEncoder().encode(JSON.stringify(statuspageSummary()));
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                // 4 MiB of JSON whitespace with no content-length, then a valid page.
                if (pulls === 64) {
                    controller.enqueue(page);
                    return controller.close();
                }
                pulls += 1;
                controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
            },
            cancel() {
                isCancelled = true;
            },
        });
        const read = createAgentProviderStatus({
            fetch: () => Promise.resolve(new Response(body)),
        });
        await expect(read('claude')).resolves.toMatchObject({
            state: 'unavailable',
            reason: 'invalidResponse',
        });
        expect(pulls).toBeLessThan(64);
        expect(isCancelled).toBe(true);
    });

    it('records the recovery after a failure', async () => {
        const write = vi.fn();
        let isOnline = false;
        let time = 0;
        const read = createAgentProviderStatus({
            fetch: () =>
                isOnline ? jsonResponse(incidentIoSummary()) : Promise.reject(new Error('offline')),
            logger: () => ({ write }),
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

describe('createAgentProviderStatus Codex history', () => {
    const history = {
        component_impacts: [
            {
                component_id: 'cx-api',
                start_at: '2026-01-02T00:00:00Z',
                end_at: '2026-01-02T01:00:00Z',
                status: 'partial_outage',
            },
        ],
        component_uptimes: [{ component_id: 'cx-api', uptime: '99.50' }],
    };

    it('attaches the 90-day history window ending now to the Codex API component', async () => {
        const now = Date.parse('2026-04-01T00:00:00Z');
        const fetch = vi.fn((url: string) =>
            jsonResponse(url.includes('/component_impacts') ? history : incidentIoSummary()),
        );
        const read = createAgentProviderStatus({ fetch, now: () => now });
        const status = await read('codex');
        expect(status).toMatchObject({
            state: 'available',
            components: [
                {
                    name: 'Codex API',
                    uptime: {
                        windowStart: now - 90 * 86_400_000,
                        windowEnd: now,
                        percent: 99.5,
                        impacts: [{ status: 'partialOutage' }],
                    },
                },
            ],
        });
        const historyUrl = new URL(String(fetch.mock.calls.at(-1)?.[0]));
        expect(historyUrl.searchParams.get('end_at')).toBe('2026-04-01T00:00:00.000Z');
    });

    it('still answers the current state when the history read fails', async () => {
        const read = createAgentProviderStatus({
            fetch: (url) =>
                url.includes('/component_impacts')
                    ? jsonResponse({}, 503)
                    : jsonResponse(incidentIoSummary()),
        });
        const status = await read('codex');
        expect(status).toMatchObject({ state: 'available' });
        expect(status?.state === 'available' && status.components[0]).toEqual({
            name: 'Codex API',
            status: 'operational',
        });
    });

    it('logs a history failure once per reason and its recovery', async () => {
        const write = vi.fn();
        let isHistoryUp = false;
        let time = 0;
        const read = createAgentProviderStatus({
            fetch: (url) =>
                url.includes('/component_impacts')
                    ? jsonResponse(isHistoryUp ? history : { component_impacts: 'changed' })
                    : jsonResponse(incidentIoSummary()),
            logger: () => ({ write }),
            now: () => time,
        });
        await read('codex');
        time += 61_000;
        await read('codex');
        isHistoryUp = true;
        time += 61_000;
        await read('codex');
        expect(write.mock.calls).toEqual([
            [
                'warn',
                'external_status.provider_history_failed',
                { fields: { provider: 'codex', reason: 'invalidResponse' } },
            ],
            [
                'info',
                'external_status.provider_history_recovered',
                { fields: { provider: 'codex', previousReason: 'invalidResponse' } },
            ],
        ]);
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
            // A path-specific fixture answers its own request; the page's other requests fall back to the host file.
            await writeFile(
                join(directory, 'status.openai.com.json'),
                JSON.stringify(incidentIoSummary()),
            );
            await writeFile(
                join(directory, 'status.openai.com.component_impacts.json'),
                JSON.stringify({
                    component_impacts: [],
                    component_uptimes: [{ component_id: 'cx-api', uptime: '100.00' }],
                }),
            );
            const withHistory = createAgentProviderStatus({
                fetch: createE2EStatusPageFetch(directory),
            });
            await expect(withHistory('codex')).resolves.toMatchObject({
                components: [{ name: 'Codex API', uptime: { percent: 100 } }],
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
