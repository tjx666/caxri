import { describe, expect, it } from 'vitest';

import {
    agentChatContextAlertsState,
    agentChatUndismissedContextAlerts,
    isAgentChatCacheRewriteNoticeable,
} from '../agent-chat-context-alerts';

const MINUTE = 60_000;

describe('agentChatContextAlertsState', () => {
    const usage = {
        totalTokens: 113_000,
        contextWindow: 200_000,
        cacheTtlMinutes: 60,
        lastResponseAt: 0,
        cacheRewriteUsd: 0.69,
    };

    it('raises nothing while the cache is warm and the context is small', () => {
        expect(agentChatContextAlertsState(usage, 49 * MINUTE, undefined)).toEqual({});
        expect(agentChatContextAlertsState(undefined, 0, undefined)).toEqual({});
    });

    it('moves from expiring to expired with the figures both surfaces word', () => {
        expect(agentChatContextAlertsState(usage, 50 * MINUTE, undefined).cache).toEqual({
            state: 'expiring',
            cacheTtlMinutes: 60,
            idleMs: 50 * MINUTE,
            remainingMs: 10 * MINUTE,
        });
        expect(agentChatContextAlertsState(usage, 75 * MINUTE, undefined).cache).toEqual({
            state: 'expired',
            cacheTtlMinutes: 60,
            idleMs: 75 * MINUTE,
        });
    });

    it('reports idle compaction while it is due before the cache expires', () => {
        expect(agentChatContextAlertsState(usage, 50 * MINUTE, 54 * MINUTE).cache).toMatchObject({
            state: 'compacting',
            remainingMs: 4 * MINUTE,
        });
    });

    it('raises context pressure at 85% of the compaction limit', () => {
        expect(
            agentChatContextAlertsState({ ...usage, totalTokens: 170_000 }, 0, undefined).pressure,
        ).toEqual({ limit: 200_000 });
        expect(
            agentChatContextAlertsState({ ...usage, totalTokens: 169_000 }, 0, undefined).pressure,
        ).toBeUndefined();
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

    it('needs the context to fill 20% of its limit when the window is known', () => {
        const priced = { cacheRewriteUsd: 0.71, contextWindow: 1_000_000 };
        expect(isAgentChatCacheRewriteNoticeable({ ...priced, totalTokens: 113_000 })).toBe(false);
        expect(isAgentChatCacheRewriteNoticeable({ ...priced, totalTokens: 200_000 })).toBe(true);
        // The limit is where the provider compacts on its own, when it says so.
        expect(
            isAgentChatCacheRewriteNoticeable({
                ...priced,
                totalTokens: 113_000,
                autoCompactThreshold: 500_000,
            }),
        ).toBe(true);
        expect(
            isAgentChatCacheRewriteNoticeable({ totalTokens: 50_000, contextWindow: 400_000 }),
        ).toBe(false);
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
