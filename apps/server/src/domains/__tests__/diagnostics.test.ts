import process from 'node:process';

import type { AppSettings } from '@caxri/protocol';
import { appSettingsSchema, defaultAppSettings } from '@caxri/protocol';
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
    it('aggregates operation timings from structured logs', () => {
        expect(
            summarizePerformanceLogs([
                [
                    JSON.stringify({ event: 'files.list', durationMs: 8 }),
                    JSON.stringify({ event: 'files.list', durationMs: 4 }),
                    JSON.stringify({ event: 'server_core.ready', durationMs: 12 }),
                    JSON.stringify({ event: 'ignored' }),
                    'not-json',
                ].join('\n'),
            ]),
        ).toEqual([
            { event: 'files.list', count: 2, averageMs: 6, minimumMs: 4, maximumMs: 8 },
            { event: 'server_core.ready', count: 1, averageMs: 12, minimumMs: 12, maximumMs: 12 },
        ]);
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
