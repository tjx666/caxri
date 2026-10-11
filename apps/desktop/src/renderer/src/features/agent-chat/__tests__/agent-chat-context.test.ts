import { describe, expect, it } from 'vitest';

import {
    agentChatCompactCommand,
    agentChatContextAlerts,
    agentChatContextUsage,
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

    it('warns from 60% of the window and turns to danger from 85%', () => {
        const tone = (totalTokens: number) =>
            agentChatContextUsage({ usage: { totalTokens, contextWindow: 100_000 } })?.tone;
        expect(tone(59_999)).toBe('normal');
        expect(tone(60_000)).toBe('warning');
        expect(tone(84_999)).toBe('warning');
        expect(tone(85_000)).toBe('danger');
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

    it('reports an expired cache with the idle time and the estimated re-read', () => {
        expect(agentChatContextAlerts(usage, 75 * MINUTE).cache).toEqual({
            text: 'Idle 1h 15m · next reply re-reads the whole conversation (est. ~$0.69)',
            detail: 'The prompt cache lasts 60m, so the next reply reads all 113k tokens again without it. The cost is an estimate at standard API prices.',
        });
        const unpriced = { totalTokens: 113_000, cacheTtlMinutes: 60, lastResponseAt: 0 };
        expect(agentChatContextAlerts(unpriced, 60 * MINUTE).cache).toEqual({
            text: 'Idle 1h · next reply re-reads the whole conversation',
            detail: 'The prompt cache lasts 60m, so the next reply reads all 113k tokens again without it.',
        });
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

describe('agentChatCompactCommand', () => {
    it('finds the provider compact command only when the provider reports one', () => {
        expect(agentChatCompactCommand(undefined)).toBeUndefined();
        expect(agentChatCompactCommand([{ name: 'review' }])).toBeUndefined();
        expect(agentChatCompactCommand([{ name: 'review' }, { name: 'compact' }])).toEqual({
            name: 'compact',
        });
    });
});
