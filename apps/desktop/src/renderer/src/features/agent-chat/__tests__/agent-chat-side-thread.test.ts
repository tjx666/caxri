import { MAX_AGENT_CHAT_SIDE_QUESTION_HISTORY } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { SideChatExchange } from '../agent-chat-side-thread';
import {
    agentChatSideHistory,
    agentChatSideSeedPrompt,
    parseAgentChatSideQuestion,
} from '../agent-chat-side-thread';

function exchange(id: string, status: SideChatExchange['status']): SideChatExchange {
    return {
        id,
        question: `q-${id}`,
        response: status === 'answered' ? `a-${id}` : undefined,
        status,
    };
}

describe('parseAgentChatSideQuestion', () => {
    it('reads the question after /btw', () => {
        expect(parseAgentChatSideQuestion('/btw what does this flag do?')).toBe(
            'what does this flag do?',
        );
        expect(parseAgentChatSideQuestion('  /btw  spaced\nsecond line')).toBe(
            'spaced\nsecond line',
        );
    });

    it('is not a side question without text or with a longer command name', () => {
        expect(parseAgentChatSideQuestion('/btw')).toBeUndefined();
        expect(parseAgentChatSideQuestion('/btw   ')).toBeUndefined();
        expect(parseAgentChatSideQuestion('/btwx hello')).toBeUndefined();
        expect(parseAgentChatSideQuestion('hello /btw there')).toBeUndefined();
    });
});

describe('agentChatSideHistory', () => {
    it('carries only answered exchanges, oldest first', () => {
        const history = agentChatSideHistory([
            exchange('1', 'answered'),
            exchange('2', 'failed'),
            exchange('3', 'pending'),
            exchange('4', 'answered'),
        ]);
        expect(history).toEqual([
            { question: 'q-1', response: 'a-1' },
            { question: 'q-4', response: 'a-4' },
        ]);
    });

    it('leaves out a retried exchange and everything after it', () => {
        const exchanges = [
            exchange('1', 'answered'),
            exchange('2', 'failed'),
            exchange('3', 'answered'),
        ];
        expect(agentChatSideHistory(exchanges, '2')).toEqual([
            { question: 'q-1', response: 'a-1' },
        ]);
    });

    it('keeps the most recent exchanges within the protocol limit', () => {
        const exchanges = Array.from(
            { length: MAX_AGENT_CHAT_SIDE_QUESTION_HISTORY + 5 },
            (_, index) => exchange(String(index), 'answered'),
        );
        const history = agentChatSideHistory(exchanges);
        expect(history).toHaveLength(MAX_AGENT_CHAT_SIDE_QUESTION_HISTORY);
        expect(history.at(-1)?.question).toBe(`q-${exchanges.length - 1}`);
    });
});

describe('agentChatSideSeedPrompt', () => {
    it('lays out the answered Q&A for the new Chat', () => {
        const prompt = agentChatSideSeedPrompt([
            exchange('1', 'answered'),
            exchange('2', 'failed'),
        ]);
        expect(prompt).toContain('Q: q-1\n\nA: a-1');
        expect(prompt).not.toContain('q-2');
    });
});
