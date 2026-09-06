import { describe, expect, it } from 'vitest';

import { percentile, runAgentProbeBenchmark } from '../agent-probe-benchmark';

describe('agent probe benchmark', () => {
    it('reads nearest-rank percentiles from unsorted samples', () => {
        const samples = [9, 1, 5, 3, 7];
        expect(percentile(samples, 0.5)).toBe(5);
        expect(percentile(samples, 0.95)).toBe(9);
        expect(percentile([], 0.5)).toBe(0);
    });

    it('measures a cold probe and a warm distribution over synthetic metadata files', async () => {
        const result = await runAgentProbeBenchmark({ files: 12, iterations: 11 });
        expect(result).toMatchObject({ files: 12, iterations: 11, rewriteEvery: 10 });
        expect(result.coldMs).toBeGreaterThan(0);
        expect(result.warm.p50Ms).toBeLessThanOrEqual(result.warm.p95Ms);
        expect(result.warm.p95Ms).toBeLessThanOrEqual(result.warm.maxMs);
    });
});
