import { describe, expect, it } from 'vitest';

import { agentChatContextAlerts, agentChatContextUsage } from '../agent-chat-context';

const MINUTE = 60_000;

describe('agentChatContextUsage', () => {
    it('reports the share of the window in use once the provider reports its size', () => {
        expect(agentChatContextUsage(undefined)).toBeUndefined();
        expect(agentChatContextUsage({ usage: { totalTokens: 500 } })).toBeUndefined();
        expect(
            agentChatContextUsage({ usage: { totalTokens: 25_000, contextWindow: 100_000 } }),
        ).toEqual({
            used: 0.25,
            totalTokens: 25_000,
            window: 100_000,
            tone: 'normal',
            breakdown: [],
        });
        expect(
            agentChatContextUsage({ usage: { totalTokens: 200_000, contextWindow: 100_000 } })
                ?.used,
        ).toBe(1);
    });

    it('measures pressure against the smaller compaction window', () => {
        const usage = agentChatContextUsage({
            usage: {
                totalTokens: 200_000,
                contextWindow: 1_000_000,
                compactWindow: 280_000,
                breakdown: [{ label: 'Messages', tokens: 190_000 }],
            },
        });
        expect(usage).toMatchObject({
            window: 280_000,
            modelWindow: 1_000_000,
            tone: 'danger',
            breakdown: [{ label: 'Messages', tokens: 190_000 }],
        });
        expect(
            agentChatContextUsage({ usage: { totalTokens: 150_000, contextWindow: 280_000 } })
                ?.tone,
        ).toBe('warning');
    });
});

describe('agentChatContextAlerts', () => {
    const usage = {
        totalTokens: 113_000,
        contextWindow: 1_000_000,
        cacheTtlMinutes: 60,
        lastResponseAt: 0,
        cacheRewriteUsd: 0.69,
    };

    it('says nothing while the cache is warm and the context is small', () => {
        expect(agentChatContextAlerts(usage, 59 * MINUTE)).toEqual({});
        expect(agentChatContextAlerts(undefined, 0)).toEqual({});
        expect(agentChatContextAlerts({ ...usage, totalTokens: 0 }, 120 * MINUTE)).toEqual({});
    });

    it('reports an expired cache with the idle time and the estimated rewrite', () => {
        expect(agentChatContextAlerts(usage, 75 * MINUTE).cache).toEqual({
            text: 'Cache expired · next message rewrites 113k tokens (~$0.69)',
            detail: 'Idle 1h 15m, past the 60m prompt cache lifetime. The cost is an estimate at standard API prices.',
        });
        const unpriced = { totalTokens: 113_000, cacheTtlMinutes: 60, lastResponseAt: 0 };
        expect(agentChatContextAlerts(unpriced, 60 * MINUTE).cache).toEqual({
            text: 'Cache expired · next message rewrites 113k tokens',
            detail: 'Idle 1h, past the 60m prompt cache lifetime.',
        });
    });

    it('suggests compacting from 70% of the compaction window', () => {
        expect(
            agentChatContextAlerts({ ...usage, totalTokens: 195_000, compactWindow: 280_000 }, 0)
                .pressure,
        ).toBeUndefined();
        expect(
            agentChatContextAlerts({ ...usage, totalTokens: 201_000, compactWindow: 280_000 }, 0),
        ).toEqual({
            pressure: {
                text: 'Context 201k / 280k · consider /compact',
                detail: 'The conversation fills 72% of the window the Agent compacts at. Compacting now keeps answers sharp.',
            },
        });
    });
});
