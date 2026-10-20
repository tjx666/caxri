import { describe, expect, it } from 'vitest';

import { agentChatQueueSendNowText } from '../agent-chat-queue';

describe('agentChatQueueSendNowText', () => {
    it('translates the protocol label kind', () => {
        expect(agentChatQueueSendNowText({ sendNowLabel: 'Send now' })).toBe('Send now');
        expect(agentChatQueueSendNowText({ sendNowLabel: 'Steer' })).toBe('Steer');
    });
});
