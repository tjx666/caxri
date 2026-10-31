import { describe, expect, it } from 'vitest';

import { narrowInvocationsToShard, parseE2EShard, shardSpecs, specWeight } from '../e2e-pool-shard';
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
});
