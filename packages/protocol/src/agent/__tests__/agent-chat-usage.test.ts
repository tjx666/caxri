import { describe, expect, it } from 'vitest';

import type { AgentChatItem } from '../agent-chat-contract.js';
import {
    agentChatAwayRecapWindow,
    agentChatCacheClock,
    agentChatContextLimit,
    agentChatContextPercent,
    agentChatContextUsage,
    currentAgentChatAwayRecap,
    formatMergeNotice,
    isAgentChatEndedByMerge,
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

describe('isAgentChatEndedByMerge', () => {
    const url = 'https://github.com/example/example/pull/1';
    const mergedAt = 1_000 * MINUTE;
    const merged = { state: 'merged' as const, mergedAt, url };
    const userMessage = (text: string, createdAt?: number): AgentChatItem => ({
        id: `message-${text}`,
        type: 'userMessage',
        text,
        ...(createdAt !== undefined && { createdAt }),
    });

    it('ends the Chat when only the merge notice arrived after the merge', () => {
        const items = [
            userMessage('Ship it', mergedAt - MINUTE),
            userMessage(formatMergeNotice(url), mergedAt + MINUTE),
        ];
        expect(isAgentChatEndedByMerge(items, merged)).toBe(true);
        expect(isAgentChatEndedByMerge(undefined, merged)).toBe(true);
        expect(isAgentChatEndedByMerge(items, { state: 'merged', url })).toBe(true);
    });

    it('keeps the Chat going once another message followed the merge', () => {
        const items = [
            userMessage(formatMergeNotice(url), mergedAt + MINUTE),
            userMessage('Now fix the follow-up', mergedAt + 2 * MINUTE),
        ];
        expect(isAgentChatEndedByMerge(items, merged)).toBe(false);
    });

    it('ignores replayed messages without a time and pull requests that did not merge', () => {
        expect(isAgentChatEndedByMerge([userMessage('Earlier')], merged)).toBe(true);
        expect(isAgentChatEndedByMerge([], { state: 'closed', url })).toBe(false);
        expect(isAgentChatEndedByMerge([], undefined)).toBe(false);
    });
});

describe('agentChatAwayRecapWindow', () => {
    it('is due three minutes after the reply, or earlier for a short cache, and stale near its expiry', () => {
        expect(agentChatAwayRecapWindow(undefined)).toBeUndefined();
        expect(agentChatAwayRecapWindow({ cacheTtlMinutes: 60, lastResponseAt: 0 })).toEqual({
            dueAt: 3 * MINUTE,
            staleAt: 54 * MINUTE,
        });
        expect(agentChatAwayRecapWindow({ cacheTtlMinutes: 2, lastResponseAt: 0 })).toEqual({
            dueAt: 1.6 * MINUTE,
            staleAt: 1.8 * MINUTE,
        });
    });

    it('never goes stale for a cache with no known expiry', () => {
        expect(agentChatAwayRecapWindow({ lastResponseAt: 0 })).toEqual({ dueAt: 3 * MINUTE });
    });
});

describe('currentAgentChatAwayRecap', () => {
    const awayRecap = { text: 'Ready to merge.', lastResponseAt: 5, generatedAt: 6 };

    it('returns the recap only while it describes the latest reply and no turn runs', () => {
        expect(
            currentAgentChatAwayRecap({ awayRecap, usage: { totalTokens: 0, lastResponseAt: 5 } }),
        ).toBe(awayRecap);
        expect(
            currentAgentChatAwayRecap({ awayRecap, usage: { totalTokens: 0, lastResponseAt: 9 } }),
        ).toBeUndefined();
        expect(
            currentAgentChatAwayRecap({
                activeTurnId: 'turn',
                awayRecap,
                usage: { totalTokens: 0, lastResponseAt: 5 },
            }),
        ).toBeUndefined();
        expect(currentAgentChatAwayRecap(undefined)).toBeUndefined();
    });
});
