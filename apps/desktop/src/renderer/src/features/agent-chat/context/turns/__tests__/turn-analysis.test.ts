import { describe, expect, it } from 'vitest';

import { MINUTE, request } from '../../__tests__/fixtures';
import { analyzeContextTurns } from '../turn-analysis';

const quiet = { input: 0 };
const turn = (user: number, modelOutput: number, toolResults: number) => ({
    user,
    modelOutput,
    toolResults,
    tools: toolResults > 0 ? [{ name: 'Read', tokens: toolResults }] : [],
});

describe('analyzeContextTurns', () => {
    it('accumulates each turn on top of the starting context and finds the largest growth', () => {
        const { points, largestGrowthIndex } = analyzeContextTurns([
            request(0, { ...quiet, cacheWrite: 10_000 }),
            request(MINUTE, {
                ...quiet,
                cacheRead: 10_000,
                cacheWrite: 3_000,
                turn: turn(200, 800, 2_000),
            }),
            request(2 * MINUTE, {
                ...quiet,
                cacheRead: 13_000,
                cacheWrite: 40_000,
                turn: turn(0, 500, 39_500),
            }),
        ]);

        expect(points.map((point) => point.base)).toEqual([10_000, 10_000, 10_000]);
        expect(points[2]).toMatchObject({ user: 200, modelOutput: 1_300, toolResults: 41_500 });
        expect(points[2].prompt).toBe(53_000);
        expect(points[2].growth).toBe(40_000);
        expect(largestGrowthIndex).toBe(2);
    });

    it('restarts from the compacted size and does not count its growth', () => {
        const { points } = analyzeContextTurns([
            request(0, { ...quiet, cacheWrite: 10_000 }),
            request(MINUTE, {
                ...quiet,
                cacheRead: 10_000,
                cacheWrite: 90_000,
                turn: turn(0, 0, 90_000),
            }),
            request(2 * MINUTE, { ...quiet, cacheWrite: 12_000, afterCompaction: true }),
            request(3 * MINUTE, {
                ...quiet,
                cacheRead: 12_000,
                cacheWrite: 1_000,
                turn: turn(100, 400, 500),
            }),
        ]);

        expect(points[2]).toMatchObject({
            afterCompaction: true,
            base: 12_000,
            toolResults: 0,
            growth: 0,
        });
        expect(points[3]).toMatchObject({ base: 12_000, toolResults: 500, user: 100 });
    });

    it('keeps the parts within the prompt when it shrinks and reports no growth without turns', () => {
        const { points, largestGrowthIndex } = analyzeContextTurns([
            request(0, { ...quiet, cacheWrite: 1_000 }),
            request(MINUTE, {
                ...quiet,
                cacheRead: 1_000,
                cacheWrite: 3_000,
                turn: turn(0, 0, 3_000),
            }),
            request(2 * MINUTE, { ...quiet, cacheRead: 2_000 }),
        ]);

        expect(points[2].base + points[2].toolResults).toBeCloseTo(2_000);
        expect(points[2].growth).toBe(0);
        expect(largestGrowthIndex).toBe(1);
        expect(
            analyzeContextTurns([request(0, { ...quiet, cacheWrite: 5 })]).largestGrowthIndex,
        ).toBeUndefined();
    });
});
