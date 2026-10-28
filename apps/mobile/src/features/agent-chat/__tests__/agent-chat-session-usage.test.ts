import type { AgentUsageReadout } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatContextRing, agentChatSessionUsageView } from '../agent-chat-session-usage';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-28T12:00:00.000Z');

const readout = (overrides: Partial<AgentUsageReadout> = {}): AgentUsageReadout => ({
    provider: 'claude',
    tokens: {
        input: 20_000,
        output: 30_000,
        cacheRead: 950_000,
        cacheWrite: 30_000,
        reasoning: 0,
        total: 1_030_000,
    },
    costUsd: 3.4,
    models: ['claude-opus-4-7'],
    unpricedModels: [],
    ...overrides,
});

describe('agentChatContextRing', () => {
    it('stays quiet below the compaction suggestion and warns with the percentage from it', () => {
        expect(agentChatContextRing(undefined)).toBeUndefined();
        expect(agentChatContextRing({ totalTokens: 500 })).toBeUndefined();
        expect(
            agentChatContextRing({
                totalTokens: 83_500,
                contextWindow: 200_000,
                autoCompactThreshold: 167_000,
            }),
        ).toEqual({
            used: 0.5,
            percent: 50,
            isWarning: false,
            accessibilityLabel: 'Context 50% used, 83.5k of 167k',
        });
        expect(agentChatContextRing({ totalTokens: 90_000, contextWindow: 100_000 })).toMatchObject(
            { percent: 90, isWarning: true },
        );
    });
});

describe('agentChatSessionUsageView', () => {
    it('shows nothing before the first response', () => {
        expect(agentChatSessionUsageView(undefined, undefined, NOW)).toEqual({
            context: undefined,
            conversation: [],
            cache: [],
        });
    });

    it("reads the context from the snapshot and the conversation's tokens and cost from the readout", () => {
        const view = agentChatSessionUsageView(
            {
                totalTokens: 250_000,
                contextWindow: 1_000_000,
                compactWindow: 280_000,
            },
            readout(),
            NOW,
        );
        expect(view.context).toEqual({
            value: '250k / 280k · 89%',
            used: 250_000 / 280_000,
            isWarning: true,
            note: "Auto-compacts within 280k of the model's 1M window.",
        });
        expect(view.conversation).toEqual([
            {
                key: 'tokens',
                label: 'Tokens',
                value: '1M',
                detail: '20k input · 30k output · 950k cache read · 30k cache write',
            },
            {
                key: 'cost',
                label: 'Est. cost',
                value: '$3.40',
                detail: 'Estimated at standard API prices; a subscription spends allowance instead.',
            },
            { key: 'models', label: 'Models', value: 'claude-opus-4-7' },
        ]);
    });

    it('marks a partial cost as a lower bound and an unpriced one as unknown', () => {
        const partial = agentChatSessionUsageView(
            undefined,
            readout({ models: ['a', 'b'], unpricedModels: ['b'] }),
            NOW,
        ).conversation.find((row) => row.key === 'cost');
        expect(partial).toMatchObject({
            value: '≥$3.40',
            detail: 'A lower bound: no price for b.',
        });
        const unpriced = agentChatSessionUsageView(
            undefined,
            readout({ unpricedModels: ['claude-opus-4-7'] }),
            NOW,
        ).conversation.find((row) => row.key === 'cost');
        expect(unpriced).toMatchObject({
            value: 'No price',
            detail: 'None of its models has a price yet.',
        });
    });

    it('counts the prompt cache down while warm, prices the rewrite once expired, and gives the hit rate', () => {
        const usage = {
            totalTokens: 113_000,
            contextWindow: 200_000,
            cacheTtlMinutes: 60,
            lastResponseAt: NOW,
            cacheRewriteUsd: 0.69,
        };
        const warm = agentChatSessionUsageView(usage, readout(), NOW + 17.5 * MINUTE).cache;
        expect(warm).toEqual([
            {
                key: 'clock',
                label: 'State',
                value: 'Warm · 43m left',
                detail: 'Kept 1h 0m after each response.',
            },
            {
                key: 'hitRate',
                label: 'Cache hit rate',
                value: '95%',
                detail: '950k read · 30k written',
            },
        ]);
        const expired = agentChatSessionUsageView(usage, undefined, NOW + 75 * MINUTE).cache;
        expect(expired).toEqual([
            {
                key: 'clock',
                label: 'State',
                value: 'Expired · idle 1h 15m',
                detail: 'Kept 1h 0m after each response. The next message rewrites 113k (~$0.69).',
            },
        ]);
    });

    it('leaves out the cache rows a provider gives no figures for', () => {
        const view = agentChatSessionUsageView(
            { totalTokens: 1_000, contextWindow: 200_000 },
            readout({
                tokens: {
                    input: 1_000,
                    output: 10,
                    cacheRead: 0,
                    cacheWrite: 0,
                    reasoning: 0,
                    total: 1_010,
                },
            }),
            NOW,
        );
        expect(view.cache).toEqual([]);
        expect(view.conversation[0]?.detail).toBe('1k input · 10 output');
    });
});
