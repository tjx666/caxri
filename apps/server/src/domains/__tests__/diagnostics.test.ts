import process from 'node:process';

import type { AppSettings } from '@caxri/protocol';
import {
    appSettingsSchema,
    defaultAppSettings,
    diagnosticsSnapshotSchema,
    methods,
} from '@caxri/protocol';
import { redactLogValue, redactSecrets } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import {
    diagnosticSettingsFile,
    normalizeHome,
    pickDiagnosticLogNames,
    summarizePerformanceLogs,
    summarizeRecentErrorIds,
} from '../diagnostics';

/**
 * The subset of `diagnostics/settings.json` these assertions read; the assertions themselves check the content.
 */
interface ExportedSettings {
    'agents.delegation': unknown;
    'agents.providers': Record<string, { launch: { args: unknown }; recovery: unknown }>;
    'environmentMonitor.mihomoRoutes': unknown;
}

function parseExport(file: string): ExportedSettings {
    return JSON.parse(file) as ExportedSettings;
}

describe('diagnostics redaction', () => {
    it('redacts secret-like keys and values', () => {
        const redacted = redactSecrets({
            apiKey: 'sensitive',
            nested: { password: 'hidden' },
            header: 'Bearer abc.def.ghi',
        });
        expect(redacted).toEqual({
            apiKey: '[REDACTED]',
            nested: { password: '[REDACTED]' },
            header: '[REDACTED]',
        });
    });

    it('normalizes home directory paths', () => {
        expect(normalizeHome(`${process.env.HOME}/code/project`)).toBe('$HOME/code/project');
    });

    it('redacts secrets embedded in log error strings before they reach diagnostics', () => {
        expect(
            redactLogValue(`${process.env.HOME}/project token=private-value Bearer abc.def.ghi`),
        ).toBe('$HOME/project token=[REDACTED] [REDACTED]');
    });

    it('excludes user-authored output recovery patterns', () => {
        const settings = structuredClone(defaultAppSettings);
        settings['agents.providers'].codex.recovery = {
            enabled: true,
            patterns: ['private proxy timeout text'],
            settleDelayMs: 500,
            continueDelayMs: 750,
        };

        const exported = diagnosticSettingsFile(settings);

        expect(exported).not.toContain('private proxy timeout text');
        expect(parseExport(exported)['agents.providers'].codex.recovery).toEqual({
            enabled: true,
            patternCount: 1,
            settleDelayMs: 500,
            continueDelayMs: 750,
        });
    });

    it('excludes delegation prompt text and launch credentials while keeping routing shape', () => {
        const settings = structuredClone(defaultAppSettings);
        settings['agents.delegation'] = {
            maxDepth: 3,
            presets: [
                {
                    name: 'reviewer',
                    provider: 'codex',
                    model: 'gpt-5.5',
                    effort: 'high',
                    useWhen: 'SENTINEL_PRESET_USE_WHEN',
                    dontUseWhen: 'SENTINEL_PRESET_DONT_USE_WHEN',
                    instructions: 'SENTINEL_PRESET_INSTRUCTIONS',
                },
            ],
            callers: {
                claude: {
                    presets: {
                        reviewer: {
                            provider: 'grok',
                            effort: 'low',
                            useWhen: 'SENTINEL_BINDING_USE_WHEN',
                        },
                    },
                    exclude: [],
                    prepend: 'SENTINEL_CALLER_PREPEND',
                    append: 'SENTINEL_CALLER_APPEND',
                },
            },
        };
        settings['agents.providers'].claude.launch.args = [
            '--model',
            'opus',
            '--api-key',
            'SENTINEL_KEY',
        ];

        const exported = diagnosticSettingsFile(settings);

        expect(exported).not.toMatch(/SENTINEL/u);
        const parsed = parseExport(exported);
        expect(parsed['agents.delegation']).toEqual({
            maxDepth: 3,
            presets: [
                {
                    name: 'reviewer',
                    provider: 'codex',
                    model: 'gpt-5.5',
                    effort: 'high',
                    useWhen: { redacted: true, length: 'SENTINEL_PRESET_USE_WHEN'.length },
                    dontUseWhen: {
                        redacted: true,
                        length: 'SENTINEL_PRESET_DONT_USE_WHEN'.length,
                    },
                    instructions: {
                        redacted: true,
                        length: 'SENTINEL_PRESET_INSTRUCTIONS'.length,
                    },
                },
            ],
            callers: {
                claude: {
                    presets: {
                        reviewer: {
                            provider: 'grok',
                            effort: 'low',
                            useWhen: {
                                redacted: true,
                                length: 'SENTINEL_BINDING_USE_WHEN'.length,
                            },
                        },
                    },
                    exclude: [],
                    prepend: { redacted: true, length: 'SENTINEL_CALLER_PREPEND'.length },
                    append: { redacted: true, length: 'SENTINEL_CALLER_APPEND'.length },
                },
            },
        });
        expect(parsed['agents.providers'].claude.launch.args).toEqual([
            '--model',
            'opus',
            '--api-key',
            '[REDACTED]',
        ]);
    });

    it('excludes Mihomo Controller access and route identities', () => {
        const settings = structuredClone(defaultAppSettings);
        settings['environmentMonitor.mihomoRoutes'] = {
            endpoint: 'http://127.0.0.1:9090',
            secret: 'SENTINEL_CONTROLLER_SECRET',
            assertions: [{ domain: 'sentinel.example', expectedNode: 'SENTINEL_NODE_NAME' }],
        };

        const exported = diagnosticSettingsFile(settings);

        expect(exported).not.toMatch(/sentinel/iu);
        expect(parseExport(exported)['environmentMonitor.mihomoRoutes']).toEqual({
            accessProtected: true,
            endpoint: 'loopback-http',
            routeCount: 1,
        });
    });

    it('declares an export rule for exactly the settings schema keys', () => {
        const exported = parseExport(diagnosticSettingsFile(defaultAppSettings));
        const byCodePoint = (left: string, right: string): number => left.localeCompare(right);

        expect(Object.keys(exported).toSorted(byCodePoint)).toEqual(
            Object.keys(appSettingsSchema.shape).toSorted(byCodePoint),
        );
    });

    it('drops a settings key that has no declared export rule', () => {
        const settings = {
            ...structuredClone(defaultAppSettings),
            'future.privateNote': 'SENTINEL_UNCLASSIFIED',
        } as AppSettings;

        expect(diagnosticSettingsFile(settings)).not.toContain('SENTINEL_UNCLASSIFIED');
    });

    it.each([
        'ghp_abcdefghijklmnopqrstuvwxyz123456',
        'github_pat_abcdef_123456',
        'xoxb-123-456-secret',
    ])('redacts common provider token format %s', (token) => {
        expect(redactSecrets(`failure ${token}`)).toBe('failure [REDACTED]');
        expect(redactLogValue(`failure ${token}`)).toBe('failure [REDACTED]');
    });
});

describe('diagnostic log discovery', () => {
    it('includes every rotated generation and excludes unrelated files', () => {
        expect(
            pickDiagnosticLogNames([
                'server-core.jsonl',
                'server-core.jsonl.1',
                'server-core.jsonl.2',
                'server-core.jsonl.3',
                'server-core.jsonl.bak',
                'server-core.log',
                'unknown.jsonl',
            ]),
        ).toEqual([
            'server-core.jsonl',
            'server-core.jsonl.1',
            'server-core.jsonl.2',
            'server-core.jsonl.3',
        ]);
    });
});

describe('diagnostics performance summary', () => {
    const at = (second: number) => `2026-10-27T08:00:${String(second).padStart(2, '0')}.000Z`;
    const record = (
        event: string,
        durationMs: number,
        second: number,
        fields?: Record<string, unknown>,
    ) => JSON.stringify({ timestamp: at(second), event, durationMs, ...(fields && { fields }) });

    it('keeps an ungrouped event as one row and adds percentiles and its window', () => {
        expect(
            summarizePerformanceLogs([
                [
                    record('files.list', 8, 2),
                    record('files.list', 4, 1),
                    record('server_core.ready', 12, 3),
                    JSON.stringify({ event: 'ignored' }),
                    'not-json',
                ].join('\n'),
            ]),
        ).toEqual([
            {
                event: 'files.list',
                count: 2,
                averageMs: 6,
                minimumMs: 4,
                p50Ms: 4,
                p95Ms: 8,
                maximumMs: 8,
                firstAt: at(1),
                lastAt: at(2),
            },
            {
                event: 'server_core.ready',
                count: 1,
                averageMs: 12,
                minimumMs: 12,
                p50Ms: 12,
                p95Ms: 12,
                maximumMs: 12,
                firstAt: at(3),
                lastAt: at(3),
            },
        ]);
    });

    it('splits ipc.request by method and boundary, and git.command by operation', () => {
        const relay = { principal: 'human-cli' };
        const rows = summarizePerformanceLogs([
            [
                ...[10, 20, 30, 40].map((ms, index) =>
                    record('ipc.request', ms, index, { method: 'session.select', ...relay }),
                ),
                ...[5, 15].map((ms, index) =>
                    record('ipc.request', ms, index, { method: 'session.select' }),
                ),
                record('ipc.request', 150, 9, { method: 'files.list', ...relay }),
                record('ipc.request', 3, 9, { method: 'files.list' }),
                record('ipc.request', 50, 9, {
                    method: 'session.select',
                    transaction: 'durable-finalizer',
                }),
                record('ipc.request', 7, 9, { method: '/Users/someone/private', ...relay }),
                record('git.command', 2, 1, { operation: 'status' }),
                record('git.command', 4, 2, { operation: 'status' }),
                record('git.command', 9, 3, { operation: 'worktree.list' }),
                record('git.command', 1, 4, { operation: 'show:/repo/secret.ts' }),
            ].join('\n'),
        ]);
        const row = (event: string, key: string, boundary?: string) =>
            rows.find(
                (entry) =>
                    entry.event === event && entry.key === key && entry.boundary === boundary,
            );

        expect(row('ipc.request', 'session.select', 'relay')).toEqual({
            event: 'ipc.request',
            key: 'session.select',
            boundary: 'relay',
            count: 4,
            averageMs: 25,
            minimumMs: 10,
            p50Ms: 20,
            p95Ms: 40,
            maximumMs: 40,
            firstAt: at(0),
            lastAt: at(3),
        });
        // The durable finalizer's record is not counted on top of its handler record.
        expect(row('ipc.request', 'session.select', 'handler')).toMatchObject({
            count: 2,
            averageMs: 10,
            p50Ms: 5,
            p95Ms: 15,
        });
        expect(row('ipc.request', 'files.list', 'relay')).toMatchObject({ count: 1, p95Ms: 150 });
        expect(row('ipc.request', 'files.list', 'handler')).toMatchObject({ count: 1, p95Ms: 3 });
        expect(row('ipc.request', 'other', 'relay')).toMatchObject({ count: 1, maximumMs: 7 });
        expect(row('git.command', 'status')).toMatchObject({ count: 2, averageMs: 3 });
        expect(row('git.command', 'worktree.list')).toMatchObject({ count: 1 });
        expect(row('git.command', 'other')).toMatchObject({ count: 1 });
        for (const entry of rows)
            expect(entry.p50Ms <= entry.p95Ms && entry.p95Ms <= entry.maximumMs).toBe(true);
        expect(JSON.stringify(rows)).not.toMatch(/someone|secret/);
        // Ordered by total time, each grouped event's `other` row last.
        expect(rows.map((entry) => [entry.key, entry.boundary])).toEqual([
            ['files.list', 'relay'],
            ['session.select', 'relay'],
            ['session.select', 'handler'],
            ['worktree.list', undefined],
            ['status', undefined],
            ['files.list', 'handler'],
            ['other', 'relay'],
            ['other', undefined],
        ]);
    });

    it('bounds the rows, keeps every ungrouped event, and folds the method tail into other', () => {
        const methodNames = Object.keys(methods).slice(0, 300);
        const lines = [
            ...Array.from({ length: 60 }, (_, index) => record(`event.${index}`, 1, 1)),
            ...methodNames.map((method, index) =>
                record('ipc.request', index + 1, 2, { method, principal: 'human-cli' }),
            ),
        ];
        const rows = summarizePerformanceLogs([lines.join('\n')]);

        expect(rows.length).toBeLessThanOrEqual(256);
        expect(rows.filter((entry) => entry.key === undefined)).toHaveLength(60);
        const methodRows = rows.filter((entry) => entry.event === 'ipc.request');
        expect(methodRows).toHaveLength(33);
        expect(methodRows.at(-1)).toMatchObject({
            key: 'other',
            count: methodNames.length - 32,
        });
        expect(methodRows[0]).toMatchObject({ key: methodNames.at(-1) });
        expect(diagnosticsSnapshotSchema.shape.performance.parse(rows)).toEqual(rows);
    });
});

describe('bug report diagnostics summary', () => {
    it('returns only bounded error identifiers without log messages or fields', () => {
        expect(
            summarizeRecentErrorIds(
                [
                    JSON.stringify({
                        timestamp: '2026-08-11T00:00:00.000Z',
                        process: 'server-core',
                        level: 'error',
                        event: 'ipc.request_failed',
                        correlationId: 'correlation-1',
                        fields: { error: 'token=private', source: 'secret.ts' },
                    }),
                    JSON.stringify({
                        timestamp: '2026-08-11T00:00:01.000Z',
                        process: 'desktop',
                        level: 'error',
                        event: 'window.close_failed',
                        fields: { error: 'private output' },
                    }),
                    JSON.stringify({
                        timestamp: '2026-08-11T00:00:02.000Z',
                        process: 'server-core',
                        level: 'error',
                        event: 'server_core.uncaught_exception',
                        correlationId: 'server-core-safe-error-id',
                        fields: { error: 'token=private', source: 'secret.ts' },
                    }),
                ].join('\n'),
                3,
            ),
        ).toEqual([
            'server-core:correlation-1',
            'desktop:window.close_failed:2026-08-11T00:00:01.000Z',
            'server-core:server-core-safe-error-id',
        ]);
    });

    it('returns no identifiers when the requested limit is zero', () => {
        expect(
            summarizeRecentErrorIds(
                JSON.stringify({
                    timestamp: '2026-08-11T00:00:00.000Z',
                    process: 'server-core',
                    level: 'error',
                    event: 'ipc.request_failed',
                }),
                0,
            ),
        ).toEqual([]);
    });
});
