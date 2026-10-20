import { describe, expect, it } from 'vitest';

import {
    agentChatCompactCommand,
    agentChatContextAlerts,
    agentChatContextAnnouncement,
    agentChatContextLimit,
    agentChatContextPercent,
    agentChatContextUsage,
    agentChatUndismissedContextAlerts,
    isAgentChatCacheRewriteNoticeable,
} from '../agent-chat-context';

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
            limit: 100_000,
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
            tone: 'warning',
            breakdown: [{ label: 'Messages', tokens: 190_000 }],
        });
    });

    it('measures against the auto-compact threshold when the provider reports one', () => {
        const usage = agentChatContextUsage({
            usage: {
                totalTokens: 83_500,
                contextWindow: 200_000,
                compactWindow: 200_000,
                autoCompactThreshold: 167_000,
            },
        });
        expect(usage).toMatchObject({ window: 200_000, limit: 167_000, compactAt: 167_000 });
        expect(usage?.used).toBeCloseTo(0.5);
        expect(agentChatContextPercent(83_500, usage?.limit ?? 0)).toBe(50);
        expect(agentChatContextLimit(200_000, 167_000)).toBe(167_000);
        expect(agentChatContextLimit(200_000, undefined)).toBe(200_000);
    });

    it('warns from 60% of the window and stays a warning past 85%, since a full context is advice', () => {
        const tone = (totalTokens: number) =>
            agentChatContextUsage({ usage: { totalTokens, contextWindow: 100_000 } })?.tone;
        expect(tone(59_999)).toBe('normal');
        expect(tone(60_000)).toBe('warning');
        expect(tone(85_000)).toBe('warning');
        expect(tone(100_000)).toBe('warning');
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
        expect(agentChatContextAlerts(usage, 49 * MINUTE)).toEqual({});
        expect(agentChatContextAlerts(undefined, 0)).toEqual({});
        expect(agentChatContextAlerts({ ...usage, totalTokens: 0 }, 120 * MINUTE)).toEqual({});
    });

    it('reports an expired cache with the idle time and the estimated re-read', () => {
        expect(agentChatContextAlerts(usage, 75 * MINUTE).cache).toEqual({
            state: 'expired',
            text: 'Idle 1h 15m · next reply re-reads the whole conversation (est. ~$0.69)',
            detail: 'The prompt cache lasts 60m, so the next reply reads all 113k tokens again without it. The cost is an estimate at standard API prices.',
        });
        const unpriced = { totalTokens: 113_000, cacheTtlMinutes: 60, lastResponseAt: 0 };
        expect(agentChatContextAlerts(unpriced, 60 * MINUTE).cache).toEqual({
            state: 'expired',
            text: 'Idle 1h · next reply re-reads the whole conversation',
            detail: 'The prompt cache lasts 60m, so the next reply reads all 113k tokens again without it.',
        });
    });

    it('counts down the last 10 minutes before the cache expires', () => {
        expect(agentChatContextAlerts(usage, 50 * MINUTE).cache).toEqual({
            state: 'expiring',
            text: 'Cache expires in 10m · reply now to skip a full re-read (est. ~$0.69)',
            detail: 'The prompt cache lasts 60m from the last reply. A message sent within 10m reuses it; after that the next reply reads all 113k tokens again. The cost is an estimate at standard API prices.',
        });
        expect(agentChatContextAlerts(usage, 59.5 * MINUTE).cache?.text).toBe(
            'Cache expires in 1m · reply now to skip a full re-read (est. ~$0.69)',
        );
    });

    it('warns only for the second half of a cache shorter than twice the lead', () => {
        const short = { ...usage, cacheTtlMinutes: 5 };
        expect(agentChatContextAlerts(short, 2 * MINUTE).cache).toBeUndefined();
        expect(agentChatContextAlerts(short, 2.5 * MINUTE).cache).toMatchObject({
            state: 'expiring',
            text: 'Cache expires in 3m · reply now to skip a full re-read (est. ~$0.69)',
        });
    });

    it('stays quiet about a cache whose rewrite costs too little to mention', () => {
        expect(agentChatContextAlerts({ ...usage, cacheRewriteUsd: 0.24 }, 75 * MINUTE)).toEqual(
            {},
        );
        expect(
            agentChatContextAlerts({ ...usage, cacheRewriteUsd: 0.25 }, 75 * MINUTE).cache?.state,
        ).toBe('expired');
        expect(agentChatContextAlerts({ ...usage, cacheRewriteUsd: 0.1 }, 50 * MINUTE)).toEqual({});
    });

    it('suggests compacting from 85% of the compaction window', () => {
        expect(
            agentChatContextAlerts({ ...usage, totalTokens: 237_000, compactWindow: 280_000 }, 0)
                .pressure,
        ).toBeUndefined();
        expect(
            agentChatContextAlerts({ ...usage, totalTokens: 241_000, compactWindow: 280_000 }, 0),
        ).toEqual({
            pressure: {
                text: 'Context 241k / 280k · consider compacting',
                detail: 'The conversation fills 86% of the window the Agent compacts at. Compacting now keeps answers sharp.',
            },
        });
    });
});

describe('isAgentChatCacheRewriteNoticeable', () => {
    it('needs a $0.25 rewrite, or 40k tokens when the model has no price', () => {
        expect(isAgentChatCacheRewriteNoticeable({ totalTokens: 1, cacheRewriteUsd: 0.25 })).toBe(
            true,
        );
        expect(
            isAgentChatCacheRewriteNoticeable({ totalTokens: 500_000, cacheRewriteUsd: 0.2 }),
        ).toBe(false);
        expect(isAgentChatCacheRewriteNoticeable({ totalTokens: 39_999 })).toBe(false);
        expect(isAgentChatCacheRewriteNoticeable({ totalTokens: 40_000 })).toBe(true);
    });
});

describe('agentChatUndismissedContextAlerts', () => {
    const cache = { state: 'expired' as const, text: 'cache', detail: 'cache detail' };
    const pressure = { text: 'pressure', detail: 'pressure detail' };

    it('hides the cache notice dismissed after the current reply, keeping the pressure notice', () => {
        expect(agentChatUndismissedContextAlerts({ cache, pressure }, 100, 100)).toEqual({
            pressure,
        });
        expect(agentChatUndismissedContextAlerts({ cache }, 100, 100)).toEqual({});
    });

    it('shows the cache notice again once a newer reply arrives, or when nothing was dismissed', () => {
        expect(agentChatUndismissedContextAlerts({ cache }, 200, 100)).toEqual({ cache });
        expect(agentChatUndismissedContextAlerts({ cache }, 100, undefined)).toEqual({ cache });
    });
});

describe('agentChatCompactCommand', () => {
    it('finds the provider compact command only when the provider reports one', () => {
        expect(agentChatCompactCommand(undefined)).toBeUndefined();
        expect(agentChatCompactCommand([{ name: 'review' }])).toBeUndefined();
        expect(agentChatCompactCommand([{ name: 'review' }, { name: 'compact' }])).toEqual({
            name: 'compact',
        });
    });
});

describe('agentChatContextAnnouncement', () => {
    const usage = {
        totalTokens: 113_000,
        contextWindow: 1_000_000,
        cacheTtlMinutes: 60,
        lastResponseAt: 0,
    };

    it('changes with the notice state, never with the ticking countdown', () => {
        const at = (minutes: number, tokens = usage.totalTokens) =>
            agentChatContextAnnouncement(
                agentChatContextAlerts({ ...usage, totalTokens: tokens }, minutes * MINUTE),
            );
        expect(at(49)).toBe('');
        expect(at(51)).toBe('Prompt cache expires soon');
        expect(at(55)).toBe(at(51));
        expect(at(61)).toBe('Prompt cache expired');
        expect(at(75)).toBe(at(61));
        expect(at(75, 900_000)).toBe(
            'Prompt cache expired. Context nearly full, consider compacting',
        );
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
