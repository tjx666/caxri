import { describe, expect, it } from 'vitest';

import { normalizeHome, redactSecrets, summarizePerformanceLogs } from '../diagnostics';
import { redactLogValue } from '../logger';

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
