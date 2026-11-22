import { describe, expect, it, vi } from 'vitest';

import {
    ANTIGRAVITY_USAGE_ARGUMENTS,
    antigravityGroupLabel,
    parseAntigravityUsage,
    readAntigravityUsage,
} from '../usage-command';

const NOW = Date.parse('2026-11-22T09:00:00Z');

/**
 * The shape `agy -p /usage --output-format json` printed on `agy` 1.5.14, with invented values.
 */
const SIGNED_IN = JSON.stringify({
    status: 'SUCCESS',
    num_turns: 0,
    command: {
        data: {
            groups: [
                {
                    name: 'Gemini Models',
                    buckets: [
                        {
                            window: '5h',
                            remaining_fraction: 0.25,
                            reset_time: '2026-11-22T12:00:00Z',
                        },
                        {
                            window: 'weekly',
                            remaining_fraction: 1,
                            reset_time: '2026-11-29T00:00:00Z',
                        },
                    ],
                },
                {
                    name: 'Claude and GPT models',
                    buckets: [
                        { window: '5h', remaining_fraction: 0, reset_time: '2026-11-22T10:00:00Z' },
                        { window: 'monthly', remaining_fraction: 0.5, disabled: true },
                    ],
                },
            ],
        },
    },
});

describe('antigravityGroupLabel', () => {
    it('shortens the group names /usage prints', () => {
        expect(antigravityGroupLabel('Gemini Models')).toBe('Gemini');
        expect(antigravityGroupLabel('Claude and GPT models')).toBe('Claude & GPT');
    });
});

describe('parseAntigravityUsage', () => {
    it('reads each enabled bucket as a grouped window', () => {
        expect(parseAntigravityUsage(SIGNED_IN, NOW)).toEqual({
            status: 'signedIn',
            limit: {
                observedAt: NOW,
                windows: [
                    {
                        windowMinutes: 300,
                        usedPercent: 75,
                        resetsAt: Date.parse('2026-11-22T12:00:00Z'),
                        scope: 'session',
                        group: 'Gemini',
                    },
                    {
                        windowMinutes: 10_080,
                        usedPercent: 0,
                        resetsAt: Date.parse('2026-11-29T00:00:00Z'),
                        scope: 'weekly',
                        group: 'Gemini',
                    },
                    {
                        windowMinutes: 300,
                        usedPercent: 100,
                        resetsAt: Date.parse('2026-11-22T10:00:00Z'),
                        scope: 'session',
                        group: 'Claude & GPT',
                    },
                ],
            },
        });
    });

    it('tells a signed-out CLI from any other failure', () => {
        expect(
            parseAntigravityUsage(
                '{"status":"ERROR","error":"authentication failed or timed out"}',
                NOW,
            ),
        ).toEqual({ status: 'signedOut' });
        expect(parseAntigravityUsage('{"status":"ERROR","error":"network"}', NOW)).toEqual({
            status: 'unknown',
        });
        expect(parseAntigravityUsage('not json', NOW)).toEqual({ status: 'unknown' });
    });
});

describe('readAntigravityUsage', () => {
    it('runs /usage and parses what a failing command still printed', async () => {
        const run = vi.fn(() =>
            Promise.reject(
                Object.assign(new Error('exit 1'), {
                    stdout: '{"status":"ERROR","error":"authentication failed or timed out"}',
                }),
            ),
        );
        await expect(
            readAntigravityUsage({ executable: '/bin/agy', run, now: () => NOW }),
        ).resolves.toEqual({ status: 'signedOut' });
        expect(run).toHaveBeenCalledWith(
            '/bin/agy',
            ANTIGRAVITY_USAGE_ARGUMENTS,
            expect.objectContaining({ timeout: 20_000 }),
        );
    });

    it('answers unknown for a command that timed out', async () => {
        const run = vi.fn(() =>
            Promise.reject(Object.assign(new Error('timeout'), { killed: true, stdout: '' })),
        );
        await expect(readAntigravityUsage({ executable: '/bin/agy', run })).resolves.toEqual({
            status: 'unknown',
        });
    });
});
