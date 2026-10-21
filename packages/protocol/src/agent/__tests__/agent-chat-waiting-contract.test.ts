import { describe, expect, it } from 'vitest';

import { methods } from '../../registry/method-registry.js';
import {
    AGENT_CHAT_WAITING_MAX_CHATS,
    AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH,
    agentChatWaitingMethods,
} from '../agent-chat-waiting-contract.js';

const method = agentChatWaitingMethods['agentChat.pendingRequests'];

const chat = {
    sessionId: 'session-1',
    terminalId: 'terminal-1',
    requests: [
        {
            id: 'request-1',
            kind: 'question',
            questions: [
                {
                    id: 'q1',
                    header: 'Tools',
                    question: 'Which tools?',
                    options: [{ label: 'Lint', description: '' }],
                    allowsOther: true,
                    multiSelect: true,
                },
            ],
        },
    ],
    prompt: 'Set up CI',
};

describe('agentChat.pendingRequests', () => {
    it('is a registered Server read that takes no parameters', () => {
        expect(methods['agentChat.pendingRequests']).toBe(method);
        expect(method.params.safeParse({}).success).toBe(true);
        expect(method.params.safeParse({ terminalId: 'terminal-1' }).success).toBe(false);
    });

    it('keeps a multiSelect question intact', () => {
        expect(method.result.parse({ chats: [chat] })).toEqual({ chats: [chat] });
    });

    it('rejects a Chat with nothing to answer', () => {
        expect(method.result.safeParse({ chats: [{ ...chat, requests: [] }] }).success).toBe(false);
    });

    it('bounds the listed Chats and the prompt excerpt', () => {
        expect(
            method.result.safeParse({
                chats: Array.from({ length: AGENT_CHAT_WAITING_MAX_CHATS + 1 }, () => chat),
            }).success,
        ).toBe(false);
        expect(
            method.result.safeParse({
                chats: [{ ...chat, prompt: 'x'.repeat(AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH + 1) }],
            }).success,
        ).toBe(false);
    });
});
