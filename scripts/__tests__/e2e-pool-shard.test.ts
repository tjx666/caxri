import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createE2EPoolPlan } from '../../e2e/support/pools';
import {
    loadSpecWeights,
    measuredSpecWeights,
    narrowInvocationsToShard,
    parseE2EShard,
    shardSpecs,
    specWeight,
} from '../e2e-pool-shard';
import { buildSpecDurationTable, collectSpecDurations } from '../e2e-spec-durations';
import { parseE2EPool } from '../run-e2e-pools';

describe('E2E pool shards', () => {
    it('accepts a shard from the argument or the environment and rejects malformed ones', () => {
        expect(parseE2EPool(['--pool', 'parallel-safe', '--shard', '1/2'])).toBe('parallel-safe');
        expect(() => parseE2EPool(['--pool', 'parallel-safe', '--other', '1/2'])).toThrow('Usage');
        expect(parseE2EShard(['--pool', 'parallel-safe'], {})).toBeUndefined();
        expect(parseE2EShard(['--pool', 'parallel-safe', '--shard', '2/3'], {})).toEqual({
            index: 2,
            total: 3,
        });
        expect(parseE2EShard(['--pool', 'parallel-safe'], { CAXRI_E2E_SHARD: '1/2' })).toEqual({
            index: 1,
            total: 2,
        });
        // The argument wins over the environment.
        expect(
            parseE2EShard(['--pool', 'parallel-safe', '--shard', '2/2'], {
                CAXRI_E2E_SHARD: '1/2',
            }),
        ).toEqual({ index: 2, total: 2 });
        for (const value of ['0/2', '3/2', '1', '1/0', 'a/b', '1/99']) {
            expect(() => parseE2EShard([], { CAXRI_E2E_SHARD: value })).toThrow('shard');
        }
    });

    it('weighs a spec by its declared tests and never below one', () => {
        expect(specWeight("test('a', () => {});\n  test.skip('b', () => {});\nconst x = 1;")).toBe(
            2,
        );
        expect(specWeight('// no tests here')).toBe(1);
    });

    it('partitions every spec into exactly one balanced shard, deterministically', () => {
        const specs = [
            'e2e/a.e2e.ts',
            'e2e/b.e2e.ts',
            'e2e/c.e2e.ts',
            'e2e/d.e2e.ts',
            'e2e/e.e2e.ts',
        ];
        const weights = new Map([
            ['e2e/a.e2e.ts', 10],
            ['e2e/b.e2e.ts', 6],
            ['e2e/c.e2e.ts', 5],
            ['e2e/d.e2e.ts', 4],
            ['e2e/e.e2e.ts', 1],
        ]);
        const first = shardSpecs(specs, weights, { index: 1, total: 2 });
        const second = shardSpecs(specs, weights, { index: 2, total: 2 });
        expect([...first, ...second].toSorted((left, right) => left.localeCompare(right))).toEqual(
            specs,
        );
        expect(first).toEqual(['e2e/a.e2e.ts', 'e2e/d.e2e.ts']);
        expect(second).toEqual(['e2e/b.e2e.ts', 'e2e/c.e2e.ts', 'e2e/e.e2e.ts']);
        expect(shardSpecs([...specs].toReversed(), weights, { index: 1, total: 2 })).toEqual(first);
        // More shards than specs leaves a shard empty instead of failing.
        expect(shardSpecs(['e2e/a.e2e.ts'], weights, { index: 2, total: 2 })).toEqual([]);
    });

    it('narrows the dispatched invocations to the specs the shard owns', async () => {
        const invocations = [{ specs: ['e2e/smoke.e2e.ts', 'e2e/logs-panel.e2e.ts'] }];
        const root = new URL('../../', import.meta.url).pathname;
        const first = await narrowInvocationsToShard(invocations, { index: 1, total: 2 }, root);
        const second = await narrowInvocationsToShard(invocations, { index: 2, total: 2 }, root);
        expect(
            [...first, ...second]
                .flatMap(({ specs }) => specs)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(invocations[0].specs.toSorted((left, right) => left.localeCompare(right)));
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
    });

    it('splits the desktop-exclusive pool into two shards that together cover every exclusive spec once', async () => {
        const root = new URL('../../', import.meta.url).pathname;
        const specs = readdirSync(`${root}e2e`)
            .filter((name) => name.endsWith('.e2e.ts'))
            .map((name) => `e2e/${name}`)
            .toSorted((left, right) => left.localeCompare(right));
        const { desktopExclusiveInvocations } = createE2EPoolPlan(specs);
        const whole = desktopExclusiveInvocations.flatMap(({ specs: owned }) => owned);
        const halves = await Promise.all(
            [1, 2].map((index) =>
                narrowInvocationsToShard(desktopExclusiveInvocations, { index, total: 2 }, root),
            ),
        );
        const [first, second] = halves.map((half) => half.flatMap(({ specs: owned }) => owned));
        expect(first.length).toBeGreaterThan(0);
        expect(second.length).toBeGreaterThan(0);
        expect(new Set([...first, ...second]).size).toBe(whole.length);
        const byName = (left: string, right: string): number => left.localeCompare(right);
        expect([...first, ...second].toSorted(byName)).toEqual(whole.toSorted(byName));
        for (const half of halves) {
            expect(half.every(({ specs: owned }) => owned.length > 0)).toBe(true);
        }
    });

    it('weighs unmeasured specs by declared tests times the median test duration', () => {
        const table = { medianTestSeconds: 4, specs: { 'e2e/known.e2e.ts': 90 } };
        const weights = measuredSpecWeights(
            ['e2e/known.e2e.ts', 'e2e/new.e2e.ts'],
            table,
            new Map([['e2e/new.e2e.ts', 3]]),
        );
        expect(weights.get('e2e/known.e2e.ts')).toBe(90);
        expect(weights.get('e2e/new.e2e.ts')).toBe(12);
    });

    it('builds the duration table from hosted job logs and skips the performance job', () => {
        const line = (job: string, location: string, durationMs: number): string =>
            `${job}\tRun\t2026-10-31T20:02:38.9Z CAXRI_E2E_PUBLIC ${JSON.stringify({ durationMs, event: 'test-end', location, retry: 0, status: 'passed' })}`;
        const log = [
            line('e2e-parallel (1/4)', 'e2e/b.e2e.ts:1:1', 2400),
            line('e2e-parallel (1/4)', 'e2e/b.e2e.ts:9:1', 1700),
            line('e2e-parallel (1/4)', 'e2e/a.e2e.ts:3:1', 10_000),
            line('e2e-perf', 'e2e/renderer.performance.e2e.ts:3:1', 99_000),
            'e2e-parallel (1/4)\tRun\tCAXRI_E2E_PUBLIC {"event":"begin","planned":3}',
        ].join('\n');
        const table = buildSpecDurationTable(collectSpecDurations([log]));
        expect(table).toEqual({
            medianTestSeconds: 2.4,
            specs: { 'e2e/a.e2e.ts': 10, 'e2e/b.e2e.ts': 4 },
        });
    });

    it.each([
        ['parallel-safe', 4],
        ['desktop-exclusive', 2],
    ] as const)(
        'balances the real %s pool across %i shards that cover every spec once',
        async (pool, total) => {
            const root = new URL('../../', import.meta.url).pathname;
            const specs = readdirSync(`${root}e2e`)
                .filter((name) => name.endsWith('.e2e.ts'))
                .map((name) => `e2e/${name}`)
                .toSorted((left, right) => left.localeCompare(right));
            const plan = createE2EPoolPlan(specs);
            const invocations =
                pool === 'parallel-safe'
                    ? plan.parallelSafeInvocations
                    : plan.desktopExclusiveInvocations;
            const whole = invocations.flatMap(({ specs: owned }) => owned);
            const weights = await loadSpecWeights(whole, root);
            const slices = Array.from({ length: total }, (_, offset) =>
                shardSpecs(whole, weights, { index: offset + 1, total }),
            );
            expect(slices.flat().toSorted((left, right) => left.localeCompare(right))).toEqual(
                whole.toSorted((left, right) => left.localeCompare(right)),
            );
            const loads = slices.map((slice) =>
                slice.reduce((sum, spec) => sum + (weights.get(spec) ?? 0), 0),
            );
            const mean = loads.reduce((sum, load) => sum + load, 0) / total;
            // The declared-test-count split left the parallel-safe pool 19% above the mean at four shards; weighing
            // by measured seconds lands within 1%, so 1.05 catches a regression to count weighting.
            expect(Math.max(...loads) / mean).toBeLessThan(1.05);
        },
    );
});
