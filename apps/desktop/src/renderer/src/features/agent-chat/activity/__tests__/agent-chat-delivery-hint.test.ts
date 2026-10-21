import { describe, expect, it } from 'vitest';

import {
    DELIVERY_HINT_TURNS,
    isAgentChatDeliveryHintDue,
    parseAgentChatDeliveryHint,
} from '../agent-chat-delivery-hint';

describe('Agent Chat delivery hint', () => {
    it('shows in the first running turns, for the rest of each, and retires after that', () => {
        const turnIds = Array.from({ length: DELIVERY_HINT_TURNS }, (_, index) => `turn-${index}`);
        expect(isAgentChatDeliveryHintDue({ isLearned: false, turnIds: [] }, 'turn-0')).toBe(true);
        expect(isAgentChatDeliveryHintDue({ isLearned: false, turnIds }, 'turn-1')).toBe(true);
        expect(isAgentChatDeliveryHintDue({ isLearned: false, turnIds }, 'turn-next')).toBe(false);
    });

    it('retires once the user queued or steered a message', () => {
        expect(isAgentChatDeliveryHintDue({ isLearned: true, turnIds: [] }, 'turn-0')).toBe(false);
    });

    it('reads a missing or damaged entry as a fresh start', () => {
        expect(parseAgentChatDeliveryHint(undefined)).toEqual({ isLearned: false, turnIds: [] });
        expect(parseAgentChatDeliveryHint({ isLearned: 'yes', turnIds: [1, 'a'] })).toEqual({
            isLearned: false,
            turnIds: ['a'],
        });
    });
});
