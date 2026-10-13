import type { BenchmarkAttempt, BenchmarkEntry, BenchmarkRun } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    buildChart,
    chartMetrics,
    configResults,
    niceScale,
    qualitySource,
    rankResults,
    runSpend,
    runTokens,
} from '../benchmark-results';

const tokens = (output: number) => ({
    input: 100,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 100 + output,
});

function attempt(entryIndex: number, overrides: Partial<BenchmarkAttempt> = {}): BenchmarkAttempt {
    return {
        id: `attempt-${entryIndex}-${overrides.repeat ?? 1}`,
        entryIndex,
        repeat: 1,
        status: 'completed',
        steps: 4,
        durationMs: 10_000,
        ...overrides,
    };
}

function run(
    entries: BenchmarkEntry[],
    attempts: BenchmarkAttempt[],
    checkCommand?: string,
): BenchmarkRun {
    return {
        id: 'run',
        title: 'Task',
        prompt: 'Task',
        entries,
        settings: {
            workspace: { kind: 'empty' },
            repeats: 1,
            concurrency: 3,
            timeoutMinutes: 20,
            ...(checkCommand && { checkCommand }),
        },
        status: 'completed',
        createdAt: 0,
        attempts,
    };
}

const LOW: BenchmarkEntry = { provider: 'codex', model: 'gpt', effort: 'low' };
const HIGH: BenchmarkEntry = { provider: 'codex', model: 'gpt', effort: 'high' };
const CLAUDE: BenchmarkEntry = { provider: 'claude', model: 'opus' };

describe('configResults', () => {
    it('aggregates repeats: median time, mean cost and score, and the check pass rate', () => {
        const [result] = configResults(
            run(
                [LOW],
                [
                    attempt(0, {
                        repeat: 1,
                        durationMs: 10_000,
                        costUsd: 0.2,
                        judge: { score: 80, reason: '' },
                        check: { status: 'passed', durationMs: 1, outputTail: '' },
                    }),
                    attempt(0, {
                        repeat: 2,
                        durationMs: 30_000,
                        costUsd: 0.4,
                        judge: { score: 60, reason: '' },
                        check: { status: 'failed', durationMs: 1, outputTail: '' },
                    }),
                    attempt(0, {
                        repeat: 3,
                        durationMs: 20_000,
                        costUsd: 0.3,
                        judge: { score: 70, reason: '' },
                        check: { status: 'passed', durationMs: 1, outputTail: '' },
                    }),
                ],
            ),
        );

        expect(result).toMatchObject({
            finished: 3,
            completed: 3,
            durationMs: 20_000,
            score: 70,
            isRunning: false,
        });
        expect(result.costUsd).toBeCloseTo(0.3);
        expect(result.checkPassRate).toBeCloseTo(2 / 3);
    });

    it('leaves the cost unknown when any completed run was not priced', () => {
        const [result] = configResults(
            run([LOW], [attempt(0, { costUsd: 0.2 }), attempt(0, { repeat: 2 })]),
        );

        expect(result.costUsd).toBeUndefined();
    });

    it('counts only completed runs toward time and tokens', () => {
        const attempts = [
            attempt(0, { durationMs: 5_000, tokens: tokens(50) }),
            attempt(0, { repeat: 2, status: 'failed', durationMs: 90_000 }),
            attempt(0, { repeat: 3, status: 'running' }),
        ];
        const [result] = configResults(run([LOW], attempts));

        expect(result).toMatchObject({
            finished: 2,
            completed: 1,
            durationMs: 5_000,
            outputTokens: 50,
            isRunning: true,
        });
    });
});

const OUTPUT_100 = tokens(100);
const OUTPUT_300 = tokens(300);

describe('configResults performance', () => {
    it('pools speed and cache over completed runs and keeps the fullest context', () => {
        const [result] = configResults(
            run(
                [LOW],
                [
                    attempt(0, {
                        timeToFirstTokenMs: 800,
                        generation: { outputTokens: 100, durationMs: 1_000, responses: 1 },
                        tokens: { ...OUTPUT_100, input: 200, cacheRead: 600, cacheWrite: 200 },
                        context: { peakTokens: 50_000, finalTokens: 40_000, window: 200_000 },
                        compactions: 0,
                    }),
                    attempt(0, {
                        repeat: 2,
                        timeToFirstTokenMs: 1_200,
                        generation: { outputTokens: 300, durationMs: 3_000, responses: 2 },
                        tokens: { ...OUTPUT_300, input: 0, cacheRead: 1_000, cacheWrite: 0 },
                        context: {
                            peakTokens: 150_000,
                            finalTokens: 30_000,
                            window: 1_000_000,
                            compactWindow: 200_000,
                        },
                        compactions: 2,
                    }),
                    attempt(0, { repeat: 3, status: 'failed', timeToFirstTokenMs: 1 }),
                ],
            ),
        );

        expect(result.timeToFirstTokenMs).toBe(1_000);
        expect(result.tokensPerSecond).toBe(100);
        expect(result.cacheHitRate).toBe(0.8);
        // Measured against the 200K window the Agent compacts at, not the model's 1M window.
        expect(result.peakContext).toEqual({ tokens: 150_000, ratio: 0.75 });
        expect(result.compactions).toBe(1);
    });

    it('leaves speed unknown when any completed run has no timing, as Grok Build has none', () => {
        const [result] = configResults(
            run(
                [LOW],
                [
                    attempt(0, {
                        generation: { outputTokens: 100, durationMs: 1_000, responses: 1 },
                    }),
                    attempt(0, { repeat: 2 }),
                ],
            ),
        );

        expect(result.tokensPerSecond).toBeUndefined();
        expect(result.cacheHitRate).toBeUndefined();
    });
});

describe('qualitySource', () => {
    it('prefers judge scores, then the check command, then nothing', () => {
        const judged = run([LOW], [attempt(0, { judge: { score: 50, reason: '' } })], 'npm test');
        const checked = run([LOW], [attempt(0)], 'npm test');
        const plain = run([LOW], [attempt(0)]);

        expect(qualitySource(judged, configResults(judged))).toBe('judge');
        expect(qualitySource(checked, configResults(checked))).toBe('check');
        expect(qualitySource(plain, configResults(plain))).toBe('none');
        expect(chartMetrics('none')).not.toContain('time');
    });
});

describe('rankResults', () => {
    it('ranks by quality, then reliability, then cost, keeping running Entries last', () => {
        const value = run(
            [LOW, HIGH, CLAUDE, { provider: 'grok', model: 'grok' }],
            [
                attempt(0, { judge: { score: 70, reason: '' }, costUsd: 0.1 }),
                attempt(1, { judge: { score: 90, reason: '' }, costUsd: 0.5 }),
                attempt(2, { judge: { score: 70, reason: '' }, costUsd: 0.05 }),
                attempt(3, { status: 'running' }),
            ],
        );

        expect(
            rankResults(configResults(value), 'judge').map((result) => result.entryIndex),
        ).toEqual([1, 2, 0, 3]);
    });
});

describe('buildChart', () => {
    const value = run(
        [LOW, HIGH, CLAUDE],
        [
            attempt(1, { judge: { score: 90, reason: '' }, costUsd: 0.5 }),
            attempt(0, { judge: { score: 70, reason: '' }, costUsd: 0.1 }),
            attempt(2, { judge: { score: 60, reason: '' } }),
        ],
    );

    it('joins one model across efforts and marks the efficient frontier', () => {
        const chart = buildChart(configResults(value), 'judge', 'cost');

        expect(chart.y).toBe('quality');
        expect(
            chart.points.map(({ entryIndex, isFrontier }) => ({ entryIndex, isFrontier })),
        ).toEqual([
            { entryIndex: 0, isFrontier: true },
            { entryIndex: 1, isFrontier: true },
        ]);
        expect(
            chart.series.map((series) => series.points.map((point) => point.entry.effort)),
        ).toEqual([['low', 'high']]);
        // The unpriced Claude Entry cannot sit on a cost axis.
        expect(chart.unplotted).toBe(1);
    });

    it('drops a point another one beats on both axes from the frontier', () => {
        const chart = buildChart(configResults(value), 'judge', 'time');

        expect(
            chart.points.filter((point) => point.isFrontier).map((point) => point.entryIndex),
        ).toEqual([1]);
        expect(chart.unplotted).toBe(0);
    });

    it('puts more on the right for a metric where higher is better', () => {
        const fast = run(
            [LOW, HIGH],
            [
                attempt(0, {
                    judge: { score: 70, reason: '' },
                    generation: { outputTokens: 200, durationMs: 1_000, responses: 1 },
                }),
                attempt(1, {
                    judge: { score: 90, reason: '' },
                    generation: { outputTokens: 50, durationMs: 1_000, responses: 1 },
                }),
            ],
        );
        const chart = buildChart(configResults(fast), 'judge', 'tokensPerSecond');

        expect(chart.points.map(({ x, isFrontier }) => ({ x, isFrontier }))).toEqual([
            { x: 200, isFrontier: true },
            { x: 50, isFrontier: true },
        ]);
    });

    it('plots time against the metric when the run has no quality signal', () => {
        const plain = run(
            [LOW, CLAUDE],
            [attempt(0, { costUsd: 0.1 }), attempt(1, { costUsd: 0.2, durationMs: 5_000 })],
        );
        const chart = buildChart(configResults(plain), 'none', 'cost');

        expect(chart.y).toBe('time');
        expect(chart.points.map((point) => point.isFrontier)).toEqual([true, true]);
    });
});

describe('niceScale', () => {
    it('covers the range with round ticks', () => {
        expect(niceScale(0.12, 0.93)).toEqual({ domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1] });
        expect(niceScale(62, 91)).toEqual({ domain: [60, 100], ticks: [60, 70, 80, 90, 100] });
    });

    it('pads a single value into a range', () => {
        const { domain } = niceScale(50, 50);

        expect(domain[0]).toBeLessThan(50);
        expect(domain[1]).toBeGreaterThan(50);
    });
});

describe('runSpend', () => {
    it('adds failed runs and the judge, and flags what could not be priced', () => {
        const value = run(
            [LOW, CLAUDE],
            [
                attempt(0, { costUsd: 0.25 }),
                attempt(0, { repeat: 2, status: 'failed', costUsd: 0.1 }),
                attempt(1),
                attempt(1, { repeat: 2, status: 'cancelled' }),
            ],
        );

        expect(runSpend({ ...value, judge: { status: 'completed', costUsd: 0.05 } })).toEqual({
            usd: 0.4,
            isPartial: true,
        });
        expect(runSpend({ ...value, attempts: value.attempts.slice(0, 2) }).isPartial).toBe(false);
    });
});

describe('runTokens', () => {
    it('sums every Attempt and the judge field by field', () => {
        const value = run([LOW], [attempt(0, { tokens: tokens(10) }), attempt(0, { repeat: 2 })]);
        value.judge = { status: 'completed', tokens: tokens(5) };

        expect(runTokens(value)).toEqual({
            input: 200,
            output: 15,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            total: 215,
        });
        const untracked = run([LOW], [attempt(0)]);
        expect(runTokens(untracked)).toBeUndefined();
    });
});
