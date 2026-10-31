import { describe, expect, it } from 'vitest';

import { usageLimitedUntil } from '../../domain/usage-contract';
import { agentChatIdleCompactionAt } from '../agent-chat-usage';

const respondedAt = 1_000_000;
const usage = { totalTokens: 80_000, cacheTtlMinutes: 60, lastResponseAt: respondedAt };

describe('agentChatIdleCompactionAt', () => {
    it('is 54 minutes into a one-hour cache for a large Claude or Grok Build context', () => {
        expect(agentChatIdleCompactionAt(usage, 'claude')).toBe(respondedAt + 54 * 60_000);
        expect(agentChatIdleCompactionAt(usage, 'grok')).toBe(respondedAt + 54 * 60_000);
    });

    it('never applies to Codex, a short cache, a small context, or a Chat with no response', () => {
        expect(agentChatIdleCompactionAt(usage, 'codex')).toBeUndefined();
        expect(agentChatIdleCompactionAt(usage, undefined)).toBeUndefined();
        expect(
            agentChatIdleCompactionAt({ ...usage, cacheTtlMinutes: 5 }, 'claude'),
        ).toBeUndefined();
        expect(
            agentChatIdleCompactionAt({ ...usage, totalTokens: 79_999 }, 'claude'),
        ).toBeUndefined();
        expect(
            agentChatIdleCompactionAt({ totalTokens: 250_000, cacheTtlMinutes: 60 }, 'claude'),
        ).toBeUndefined();
        expect(agentChatIdleCompactionAt(undefined, 'claude')).toBeUndefined();
    });

    it('moves past a used-up plan limit that resets before the cache expires, and drops one that resets later', () => {
        const minute = 60_000;
        const hold = (resetMinutes: number, lastResponseAt = respondedAt) => ({
            lastResponseAt,
            resetsAt: respondedAt + resetMinutes * minute,
        });
        // A reset before the usual due time changes nothing.
        expect(agentChatIdleCompactionAt(usage, 'claude', hold(30))).toBe(
            respondedAt + 54 * minute,
        );
        expect(agentChatIdleCompactionAt(usage, 'claude', hold(56))).toBe(
            respondedAt + 56 * minute + 30_000,
        );
        expect(agentChatIdleCompactionAt(usage, 'claude', hold(59.6))).toBeUndefined();
        expect(agentChatIdleCompactionAt(usage, 'claude', hold(90))).toBeUndefined();
        // A hold recorded for an earlier response no longer applies once the Chat replied again.
        expect(agentChatIdleCompactionAt(usage, 'claude', hold(90, respondedAt - minute))).toBe(
            respondedAt + 54 * minute,
        );
    });
});

describe('usageLimitedUntil', () => {
    const now = 1_000_000;
    const window = (usedPercent: number, resetsAt?: number, scope?: 'session' | 'weekly') => ({
        windowMinutes: 300,
        usedPercent,
        ...(resetsAt !== undefined && { resetsAt }),
        ...(scope && { scope }),
    });

    it('is the latest reset of a used-up window', () => {
        expect(
            usageLimitedUntil(
                { windows: [window(100, now + 10, 'session'), window(100, now + 20, 'weekly')] },
                now,
            ),
        ).toBe(now + 20);
        expect(
            usageLimitedUntil(
                { windows: [window(100, now + 10, 'session'), window(100, now + 20, 'weekly')] },
                now,
                'session',
            ),
        ).toBe(now + 10);
    });

    it('lets a request through below 100%, after the reset, on credits, or without a reading', () => {
        expect(usageLimitedUntil({ windows: [window(99, now + 10)] }, now)).toBeUndefined();
        expect(usageLimitedUntil({ windows: [window(100, now)] }, now)).toBeUndefined();
        expect(usageLimitedUntil({ windows: [window(100)] }, now)).toBeUndefined();
        expect(
            usageLimitedUntil(
                { windows: [window(100, now + 10)], credits: { unlimited: false, balance: 5 } },
                now,
            ),
        ).toBeUndefined();
        expect(usageLimitedUntil(undefined, now)).toBeUndefined();
        expect(
            usageLimitedUntil({ windows: [window(100, now + 10)] }, now, 'weekly'),
        ).toBeUndefined();
    });
});
