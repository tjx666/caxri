import { describe, expect, it } from 'vitest';

import { affectedTestArguments, parseShard, unitTestCommand } from '../run-ci-unit-tests';

describe('sharded CI unit tests', () => {
    it('runs every suite reachable through imports from changed sources', () => {
        expect(
            affectedTestArguments([
                'apps/server/src/index.ts',
                'docs/testing.md',
                'e2e/files.e2e.ts',
            ]),
        ).toEqual([
            'vitest',
            'related',
            '--run',
            '--passWithNoTests',
            '--silent=passed-only',
            'apps/server/src/index.ts',
            'e2e/files.e2e.ts',
        ]);
        expect(affectedTestArguments(['docs/testing.md'])).toBeUndefined();
    });

    it('shards the affected related run and skips a shard with no source change', () => {
        expect(unitTestCommand('affected', '2/2', ['apps/server/src/index.ts'], {})).toEqual({
            arguments: [
                'vitest',
                'related',
                '--run',
                '--passWithNoTests',
                '--silent=passed-only',
                'apps/server/src/index.ts',
                '--shard=2/2',
            ],
            command: 'bunx',
        });
        expect(unitTestCommand('affected', '1/2', ['docs/testing.md'], {})).toBeUndefined();
    });

    it('shards the complete suite through the authorized test script with its metric label', () => {
        expect(
            unitTestCommand('full', '1/2', [], {
                CAXRI_VITEST_MAX_WORKERS: '2',
                CAXRI_VITEST_PARTITION: 'optimized',
            }),
        ).toEqual({
            arguments: [
                'run',
                'scripts/ci-metrics.ts',
                '--label',
                'Vitest full suite partition=optimized workers=2 shard=1/2',
                '--',
                'bun',
                'run',
                'test',
                '--shard=1/2',
            ],
            command: 'bun',
        });
    });

    it('rejects a malformed or out-of-range shard', () => {
        expect(parseShard('1/2')).toBe('1/2');
        for (const value of [undefined, '', '0/2', '3/2', '1', 'a/b']) {
            expect(() => parseShard(value)).toThrow('CAXRI_VITEST_SHARD');
        }
    });
});
