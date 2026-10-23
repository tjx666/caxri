import type { AgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { isAgentChatTurnResumable } from '../send/agent-chat-resume';

function chat(status: AgentChatTurn['status'], activeTurnId?: string) {
    return {
        activeTurnId,
        turns: [
            { id: 'earlier', status: 'completed' as const },
            { id: 't', status },
        ],
    };
}

describe('isAgentChatTurnResumable', () => {
    it('offers to continue after the latest turn was stopped, cut off, or failed', () => {
        expect(isAgentChatTurnResumable(chat('interrupted'))).toBe(true);
        expect(isAgentChatTurnResumable(chat('failed'))).toBe(true);
    });

    it('does not after a finished turn, while a turn runs, or before the Chat loaded', () => {
        expect(isAgentChatTurnResumable(chat('completed'))).toBe(false);
        expect(isAgentChatTurnResumable(chat('interrupted', 'next'))).toBe(false);
        expect(isAgentChatTurnResumable({ turns: [] })).toBe(false);
        expect(isAgentChatTurnResumable(undefined)).toBe(false);
    });
});
