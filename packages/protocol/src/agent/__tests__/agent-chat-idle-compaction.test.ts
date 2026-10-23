import { describe, expect, it } from 'vitest';

import { agentChatIdleCompactionAt } from '../agent-chat-usage';

const respondedAt = 1_000_000;
const usage = { totalTokens: 200_000, cacheTtlMinutes: 60, lastResponseAt: respondedAt };

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
            agentChatIdleCompactionAt({ ...usage, totalTokens: 199_999 }, 'claude'),
        ).toBeUndefined();
        expect(
            agentChatIdleCompactionAt({ totalTokens: 250_000, cacheTtlMinutes: 60 }, 'claude'),
        ).toBeUndefined();
        expect(agentChatIdleCompactionAt(undefined, 'claude')).toBeUndefined();
    });
});
