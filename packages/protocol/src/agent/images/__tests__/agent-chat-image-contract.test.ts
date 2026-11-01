import { describe, expect, it } from 'vitest';

import { agentChatImageRetryDelay, settleAgentChatImageAnswer } from '../agent-chat-image-contract';

describe('agentChatImageRetryDelay', () => {
    it('asks again for a message not recorded yet ever more slowly, then gives up', () => {
        expect([1, 2, 3, 4, 5, 19].map(agentChatImageRetryDelay)).toEqual([
            2000, 4000, 8000, 15_000, 15_000, 15_000,
        ]);
        expect(agentChatImageRetryDelay(20)).toBe(false);
    });

    it('keeps a pending answer until the retries run out, then settles on unavailable', () => {
        expect(settleAgentChatImageAnswer('data:image/png;base64,AA==', 30)).toBe(
            'data:image/png;base64,AA==',
        );
        expect(settleAgentChatImageAnswer({ pending: true }, 2)).toEqual({ pending: true });
        expect(settleAgentChatImageAnswer({ pending: true }, 18)).toEqual({ pending: true });
        expect(settleAgentChatImageAnswer({ pending: true }, 19)).toBeNull();
    });
});
