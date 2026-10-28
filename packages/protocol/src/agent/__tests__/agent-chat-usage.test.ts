import { describe, expect, it } from 'vitest';

import {
    agentChatCacheClock,
    agentChatContextLimit,
    agentChatContextPercent,
    agentChatContextUsage,
} from '../agent-chat-usage.js';

const MINUTE = 60_000;

describe('agentChatContextUsage', () => {
    it('reports the share of the window in use once the provider reports its size', () => {
        expect(agentChatContextUsage(undefined)).toBeUndefined();
        expect(agentChatContextUsage({ totalTokens: 500 })).toBeUndefined();
        expect(agentChatContextUsage({ totalTokens: 25_000, contextWindow: 100_000 })).toEqual({
            used: 0.25,
            totalTokens: 25_000,
            window: 100_000,
            limit: 100_000,
            tone: 'normal',
            breakdown: [],
        });
        expect(agentChatContextUsage({ totalTokens: 200_000, contextWindow: 100_000 })?.used).toBe(
            1,
        );
    });

    it('measures pressure against the smaller compaction window', () => {
        const usage = agentChatContextUsage({
            totalTokens: 250_000,
            contextWindow: 1_000_000,
            compactWindow: 280_000,
            breakdown: [{ label: 'Messages', tokens: 190_000 }],
        });
        expect(usage).toMatchObject({
            window: 280_000,
            modelWindow: 1_000_000,
            tone: 'warning',
            breakdown: [{ label: 'Messages', tokens: 190_000 }],
        });
    });

    it('measures against the auto-compact threshold when the provider reports one', () => {
        const usage = agentChatContextUsage({
            totalTokens: 83_500,
            contextWindow: 200_000,
            compactWindow: 200_000,
            autoCompactThreshold: 167_000,
        });
        expect(usage).toMatchObject({ window: 200_000, limit: 167_000, compactAt: 167_000 });
        expect(usage?.used).toBeCloseTo(0.5);
        expect(agentChatContextPercent(83_500, usage?.limit ?? 0)).toBe(50);
        expect(agentChatContextLimit(200_000, 167_000)).toBe(167_000);
        expect(agentChatContextLimit(200_000, undefined)).toBe(200_000);
    });

    it('warns from 85% of the window, where compacting is suggested, and stays a warning when full', () => {
        const tone = (totalTokens: number) =>
            agentChatContextUsage({ totalTokens, contextWindow: 100_000 })?.tone;
        expect(tone(84_999)).toBe('normal');
        expect(tone(85_000)).toBe('warning');
        expect(tone(100_000)).toBe('warning');
    });
});

describe('agentChatContextPercent', () => {
    it('rounds the share to a whole percent, clamped to the window', () => {
        expect(agentChatContextPercent(2040, 160_000)).toBe(1);
        expect(agentChatContextPercent(150_000, 160_000)).toBe(94);
        expect(agentChatContextPercent(200_000, 160_000)).toBe(100);
        expect(agentChatContextPercent(10, 0)).toBe(0);
    });
});

describe('agentChatCacheClock', () => {
    it('counts down while warm and reports the idle time once expired', () => {
        expect(agentChatCacheClock(undefined, 5, 0)).toBeUndefined();
        expect(agentChatCacheClock(0, 5, 2 * MINUTE)).toEqual({
            state: 'warm',
            remainingMs: 3 * MINUTE,
            idleMs: 2 * MINUTE,
        });
        expect(agentChatCacheClock(0, 5, 7 * MINUTE)).toMatchObject({
            state: 'expired',
            idleMs: 7 * MINUTE,
        });
    });
});
