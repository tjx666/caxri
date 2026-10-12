import type { AgentChatContextChange } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { analyzeContextCache, cacheClock } from '../cache-analysis';
import { MINUTE, request } from './fixtures';

describe('analyzeContextCache', () => {
    it('reports no break while each request reads the previous prompt back', () => {
        const analysis = analyzeContextCache(
            [
                request(0, { cacheWrite: 20_000 }),
                request(MINUTE, { cacheRead: 20_000, cacheWrite: 1_000 }),
                request(2 * MINUTE, { cacheRead: 21_000, cacheWrite: 500 }),
            ],
            [],
            5,
        );
        expect(analysis.breaks).toEqual([]);
        expect(analysis.misses).toBe(0);
        expect(analysis.readTokens).toBe(41_000);
        expect(analysis.writeTokens).toBe(21_500);
        expect(analysis.hitRate).toBeCloseTo(41_000 / (41_000 + 21_500 + 6));
    });

    it('ignores a small loss under the status line threshold', () => {
        const analysis = analyzeContextCache(
            [
                request(0, { cacheWrite: 100_000 }),
                request(MINUTE, { cacheRead: 98_500, cacheWrite: 1_600 }),
            ],
            [],
            5,
        );
        expect(analysis.breaks).toEqual([]);
    });

    it('classifies breaks as compaction, model switch, expiry, then a changed prefix', () => {
        const analysis = analyzeContextCache(
            [
                request(0, { cacheWrite: 50_000, model: 'claude-opus-4-5' }),
                request(MINUTE, {
                    cacheRead: 13_000,
                    cacheWrite: 9_000,
                    afterCompaction: true,
                    model: 'claude-opus-4-5',
                }),
                request(2 * MINUTE, {
                    cacheRead: 0,
                    cacheWrite: 22_000,
                    model: 'claude-sonnet-4-5',
                }),
                request(20 * MINUTE, {
                    cacheRead: 0,
                    cacheWrite: 22_000,
                    cacheWriteUsd: 0.08,
                    model: 'claude-sonnet-4-5',
                }),
                request(21 * MINUTE, {
                    cacheRead: 13_000,
                    cacheWrite: 9_000,
                    model: 'claude-sonnet-4-5',
                }),
            ],
            [],
            5,
        );
        expect(analysis.breaks.map((item) => item.kind)).toEqual([
            'compaction',
            'model',
            'ttl',
            'prefix',
        ]);
        expect(analysis.breaks[1]).toMatchObject({
            fromModel: 'claude-opus-4-5',
            toModel: 'claude-sonnet-4-5',
        });
        expect(analysis.breaks[2]).toMatchObject({
            kept: 0,
            expected: 22_002,
            rewritten: 22_000,
            rewriteUsd: 0.08,
        });
        expect(analysis.points[3].breakKind).toBe('ttl');
        // Compaction is an expected rebuild, not a miss.
        expect(analysis.misses).toBe(3);
        expect(analysis.missTokens).toBe(22_000 + 22_000 + 9_000);
        expect(analysis.missUsd).toBeCloseTo(0.08);
        expect(analysis.hasUnpricedWrites).toBe(true);
    });

    it('uses the hour lifetime once a request reports it', () => {
        const analysis = analyzeContextCache(
            [
                request(0, { cacheWrite: 30_000, cacheTtlMinutes: 60 }),
                request(30 * MINUTE, { cacheRead: 0, cacheWrite: 30_000, cacheTtlMinutes: 60 }),
            ],
            [],
            5,
        );
        expect(analysis.ttlMinutes).toBe(60);
        expect(analysis.breaks[0].kind).toBe('prefix');
    });

    it('attributes the prefix changes noticed since the previous request', () => {
        const changes: AgentChatContextChange[] = [
            { at: 10, kind: 'skillsAdded', names: ['old'] },
            {
                at: MINUTE + 20_000,
                kind: 'mcpToolsAdded',
                names: ['mcp__github__search'],
                tokenDelta: 4_000,
            },
        ];
        const analysis = analyzeContextCache(
            [
                request(MINUTE / 2, { cacheWrite: 30_000 }),
                request(2 * MINUTE, { cacheRead: 12_000, cacheWrite: 22_000 }),
            ],
            changes,
            5,
        );
        expect(analysis.breaks[0].changes).toEqual([changes[1]]);
    });
});

describe('cacheClock', () => {
    it('counts down while warm and reports the idle time once expired', () => {
        expect(cacheClock(undefined, 5, 0)).toBeUndefined();
        expect(cacheClock(0, 5, 2 * MINUTE)).toEqual({
            state: 'warm',
            remainingMs: 3 * MINUTE,
            idleMs: 2 * MINUTE,
        });
        expect(cacheClock(0, 5, 7 * MINUTE)).toMatchObject({
            state: 'expired',
            idleMs: 7 * MINUTE,
        });
    });
});
