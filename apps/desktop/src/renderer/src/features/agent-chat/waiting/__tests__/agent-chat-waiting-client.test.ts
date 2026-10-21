import { describe, expect, it } from 'vitest';

import { isAgentChatWaitingPatch } from '../agent-chat-waiting-client';

describe('isAgentChatWaitingPatch', () => {
    it('re-reads the waiting list when a patch replaces requests or resets the Chat', () => {
        expect(
            isAgentChatWaitingPatch({ operations: [{ op: 'state', state: { requests: [] } }] }),
        ).toBe(true);
        expect(isAgentChatWaitingPatch({ operations: [{ op: 'reset' }] })).toBe(true);
    });

    it('ignores streamed text and state that leaves requests alone', () => {
        expect(
            isAgentChatWaitingPatch({
                operations: [
                    { op: 'appendText', itemId: 'item-1', delta: 'more' },
                    { op: 'state', state: { status: 'ready' } },
                ],
            }),
        ).toBe(false);
    });
});
