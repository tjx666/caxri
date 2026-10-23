import type { AgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { isAgentChatResumeOffered, isAgentChatTurnResumable } from '../send/agent-chat-resume';

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

describe('isAgentChatResumeOffered', () => {
    const idle = {
        canSend: true,
        hasContent: false,
        hasQueue: false,
        isAttaching: false,
        isEditing: false,
        isGoalMode: false,
        isSending: false,
        snapshot: chat('interrupted'),
    };

    it('offers Continue from an idle, empty composer after a stopped turn', () => {
        expect(isAgentChatResumeOffered(idle)).toBe(true);
    });

    it.each([
        ['the Chat refuses messages', { canSend: false }],
        ['a draft is typed', { hasContent: true }],
        ['a queued message will run', { hasQueue: true }],
        ['an image is being read', { isAttaching: true }],
        ['"Edit from here" owns the draft', { isEditing: true }],
        ['Goal mode owns the draft', { isGoalMode: true }],
        ['a message is in flight', { isSending: true }],
        ['the latest turn finished', { snapshot: chat('completed') }],
    ])('keeps Send when %s', (_name, change) => {
        expect(isAgentChatResumeOffered({ ...idle, ...change })).toBe(false);
    });
});
