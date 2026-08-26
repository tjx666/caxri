import process from 'node:process';

import { defaultAppSettings } from '@caxri/protocol';
import { redactLogValue, redactSecrets } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import {
    diagnosticSettings,
    normalizeHome,
    summarizePerformanceLogs,
    summarizeRecentErrorIds,
} from '../diagnostics';

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

        const exported = JSON.stringify(diagnosticSettings(settings));

        expect(exported).not.toContain('private proxy timeout text');
        expect(exported).toContain('"patternCount":1');
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

describe('diagnostics performance summary', () => {
    it('aggregates operation timings from structured logs', () => {
        expect(
            summarizePerformanceLogs([
                [
                    JSON.stringify({ event: 'files.list', durationMs: 8 }),
                    JSON.stringify({ event: 'files.list', durationMs: 4 }),
                    JSON.stringify({ event: 'runtime.ready', durationMs: 12 }),
                    JSON.stringify({ event: 'ignored' }),
                    'not-json',
                ].join('\n'),
            ]),
        ).toEqual([
            { event: 'files.list', count: 2, averageMs: 6, minimumMs: 4, maximumMs: 8 },
            { event: 'runtime.ready', count: 1, averageMs: 12, minimumMs: 12, maximumMs: 12 },
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
                        process: 'runtime',
                        level: 'error',
                        event: 'ipc.request_failed',
                        correlationId: 'correlation-1',
                        fields: { error: 'token=private', source: 'secret.ts' },
                    }),
                    JSON.stringify({
                        timestamp: '2026-08-11T00:00:01.000Z',
                        process: 'main',
                        level: 'error',
                        event: 'window.close_failed',
                        fields: { error: 'private output' },
                    }),
                    JSON.stringify({
                        timestamp: '2026-08-11T00:00:02.000Z',
                        process: 'host',
                        level: 'error',
                        event: 'runtime_child_error',
                        correlationId: 'host-safe-error-id',
                        fields: { error: 'token=private', source: 'secret.ts' },
                    }),
                ].join('\n'),
                3,
            ),
        ).toEqual([
            'runtime:correlation-1',
            'main:window.close_failed:2026-08-11T00:00:01.000Z',
            'host:host-safe-error-id',
        ]);
    });

    it('returns no identifiers when the requested limit is zero', () => {
        expect(
            summarizeRecentErrorIds(
                JSON.stringify({
                    timestamp: '2026-08-11T00:00:00.000Z',
                    process: 'runtime',
                    level: 'error',
                    event: 'ipc.request_failed',
                }),
                0,
            ),
        ).toEqual([]);
    });
});
