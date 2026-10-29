import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    agentChatCompactCommand,
    agentChatContextAlerts,
    agentChatContextAnnouncement,
    agentChatContextRowState,
    agentChatUndismissedContextAlerts,
    isAgentChatCacheRewriteNoticeable,
} from '../agent-chat-context';

const MINUTE = 60_000;

describe('agentChatContextAlerts', () => {
    const usage = {
        totalTokens: 113_000,
        contextWindow: 200_000,
        cacheTtlMinutes: 60,
        lastResponseAt: 0,
        cacheRewriteUsd: 0.69,
    };

    it('says nothing while the cache is warm and the context is small', () => {
        expect(agentChatContextAlerts(usage, 49 * MINUTE, undefined, translate)).toEqual({});
        expect(agentChatContextAlerts(undefined, 0, undefined, translate)).toEqual({});
        expect(
            agentChatContextAlerts(
                { ...usage, totalTokens: 0 },
                120 * MINUTE,
                undefined,
                translate,
            ),
        ).toEqual({});
    });

    it('reports an expired cache with the idle time and the estimated re-read', () => {
        expect(agentChatContextAlerts(usage, 75 * MINUTE, undefined, translate).cache).toEqual({
            state: 'expired',
            text: 'Idle 1h 15m · next reply re-reads the whole conversation (est. ~$0.69)',
            detail: 'The Agent keeps a conversation ready for 60 minutes after each reply. After that, the next reply reads the whole conversation (113k) again, which is slower and costs more. The cost is an estimate at standard API prices.',
        });
        const unpriced = { totalTokens: 113_000, cacheTtlMinutes: 60, lastResponseAt: 0 };
        expect(agentChatContextAlerts(unpriced, 60 * MINUTE, undefined, translate).cache).toEqual({
            state: 'expired',
            text: 'Idle 1h · next reply re-reads the whole conversation',
            detail: 'The Agent keeps a conversation ready for 60 minutes after each reply. After that, the next reply reads the whole conversation (113k) again, which is slower and costs more.',
        });
    });

    it('counts down the last 10 minutes before the cache expires', () => {
        expect(agentChatContextAlerts(usage, 50 * MINUTE, undefined, translate).cache).toEqual({
            state: 'expiring',
            text: 'Reply within 10m to skip a full re-read (est. ~$0.69)',
            detail: 'The Agent keeps a conversation ready for 60 minutes after each reply. A message sent within 10m picks up where it left off; after that, the next reply reads the whole conversation (113k) again. The cost is an estimate at standard API prices.',
        });
        expect(agentChatContextAlerts(usage, 59.5 * MINUTE, undefined, translate).cache?.text).toBe(
            'Reply within 1m to skip a full re-read (est. ~$0.69)',
        );
    });

    it('says the Chat compacts on its own when idle compaction is due before the cache expires', () => {
        const compactsAt = 54 * MINUTE;
        expect(agentChatContextAlerts(usage, 49 * MINUTE, compactsAt, translate)).toEqual({});
        expect(agentChatContextAlerts(usage, 50 * MINUTE, compactsAt, translate).cache).toEqual({
            state: 'compacting',
            text: 'Auto-compacts in 4m, before the cache expires',
            detail: 'The Agent keeps a conversation ready for 60 minutes after each reply. Unless you reply first, Caxri compacts this conversation (113k) in 4m, so your next reply reads a summary instead of the whole conversation. You can turn this off in Settings. The cost is an estimate at standard API prices.',
        });
        // Past the due time (a busy Chat, or one not compacted yet) the ordinary countdown returns.
        expect(
            agentChatContextAlerts(usage, 55 * MINUTE, compactsAt, translate).cache,
        ).toMatchObject({
            state: 'expiring',
            text: 'Reply within 5m to skip a full re-read (est. ~$0.69)',
        });
    });

    it('warns only for the second half of a cache shorter than twice the lead', () => {
        const short = { ...usage, cacheTtlMinutes: 5 };
        expect(
            agentChatContextAlerts(short, 2 * MINUTE, undefined, translate).cache,
        ).toBeUndefined();
        expect(
            agentChatContextAlerts(short, 2.5 * MINUTE, undefined, translate).cache,
        ).toMatchObject({
            state: 'expiring',
            text: 'Reply within 3m to skip a full re-read (est. ~$0.69)',
        });
    });

    it('stays quiet about a cache whose rewrite costs too little to mention', () => {
        expect(
            agentChatContextAlerts(
                { ...usage, cacheRewriteUsd: 0.24 },
                75 * MINUTE,
                undefined,
                translate,
            ),
        ).toEqual({});
        expect(
            agentChatContextAlerts(
                { ...usage, cacheRewriteUsd: 0.25 },
                75 * MINUTE,
                undefined,
                translate,
            ).cache?.state,
        ).toBe('expired');
        expect(
            agentChatContextAlerts(
                { ...usage, cacheRewriteUsd: 0.1 },
                50 * MINUTE,
                undefined,
                translate,
            ),
        ).toEqual({});
    });

    it('suggests compacting from 85% of the compaction window', () => {
        expect(
            agentChatContextAlerts(
                { ...usage, totalTokens: 237_000, compactWindow: 280_000 },
                0,
                undefined,
                translate,
            ).pressure,
        ).toBeUndefined();
        expect(
            agentChatContextAlerts(
                { ...usage, totalTokens: 241_000, compactWindow: 280_000 },
                0,
                undefined,
                translate,
            ),
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
        contextWindow: 200_000,
        cacheTtlMinutes: 60,
        lastResponseAt: 0,
    };

    it('changes with the notice state, never with the ticking countdown', () => {
        const at = (minutes: number, tokens = usage.totalTokens) =>
            agentChatContextAnnouncement(
                agentChatContextAlerts(
                    { ...usage, totalTokens: tokens },
                    minutes * MINUTE,
                    undefined,
                    translate,
                ),
                translate,
            );
        expect(at(49)).toBe('');
        expect(at(51)).toBe('Reply soon to skip a full re-read');
        expect(at(55)).toBe(at(51));
        expect(at(61)).toBe('The next reply re-reads the whole conversation');
        expect(at(75)).toBe(at(61));
        expect(at(75, 900_000)).toBe(
            'The next reply re-reads the whole conversation. Context nearly full, consider compacting',
        );
    });
});

describe('agentChatContextRowState', () => {
    const notice = { text: 'notice', detail: 'detail' };

    it('offers Compact now while idle compaction counts down', () => {
        expect(
            agentChatContextRowState({ cache: { ...notice, state: 'compacting' } }, true, true),
        ).toEqual({ canCompact: true, isCompacting: true, isExpired: false, isVisible: true });
    });

    it('offers Compact for context pressure but not for a plain cache countdown', () => {
        expect(agentChatContextRowState({ pressure: notice }, true, true).canCompact).toBe(true);
        expect(
            agentChatContextRowState({ cache: { ...notice, state: 'expiring' } }, true, true)
                .canCompact,
        ).toBe(false);
    });

    it('never offers Compact without a provider compact command, and hides without room', () => {
        expect(
            agentChatContextRowState({ cache: { ...notice, state: 'compacting' } }, true, false)
                .canCompact,
        ).toBe(false);
        expect(agentChatContextRowState({ pressure: notice }, false, true).isVisible).toBe(false);
    });
});
