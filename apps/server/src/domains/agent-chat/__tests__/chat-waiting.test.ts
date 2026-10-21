import type { AgentChatItem, AgentChatRequest } from '@caxri/protocol';
import {
    AGENT_CHAT_WAITING_MAX_CHATS,
    AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { WaitingChatSource } from '../chat-waiting';
import { readWaitingChats } from '../chat-waiting';

const approval: AgentChatRequest = {
    id: 'request-1',
    kind: 'command',
    command: 'rm -rf build',
    decisions: ['accept', 'decline'],
};

function source(
    terminalId: string,
    overrides: Partial<WaitingChatSource> & { items?: AgentChatItem[] } = {},
): WaitingChatSource {
    const { items = [], ...rest } = overrides;
    return { terminalId, snapshot: { items, requests: [approval] }, isOpen: true, ...rest };
}

const sessionOf = (terminalId: string): string | undefined => `session-of-${terminalId}`;

describe('readWaitingChats', () => {
    it('lists each live Chat with requests under its Session, in the given order', () => {
        expect(readWaitingChats([source('b'), source('a')], sessionOf)).toEqual([
            { sessionId: 'session-of-b', terminalId: 'b', requests: [approval] },
            { sessionId: 'session-of-a', terminalId: 'a', requests: [approval] },
        ]);
    });

    it('skips a Chat whose provider is gone instead of reopening it, one with nothing to ask, and an unknown Terminal', () => {
        const closed = source('closed', { isOpen: false });
        const idle = source('idle', { snapshot: { items: [], requests: [] } });
        expect(
            readWaitingChats([closed, idle, source('gone')], (terminalId) =>
                terminalId === 'gone' ? undefined : sessionOf(terminalId),
            ),
        ).toEqual([]);
    });

    it('quotes the latest message the user typed, not a delegated task pointer or a blank one', () => {
        const items: AgentChatItem[] = [
            { id: 'm1', type: 'userMessage', text: '  Set up CI  ' },
            {
                id: 'm2',
                type: 'userMessage',
                text: 'Task pointer',
                delegatedTask: { delegationId: 'delegation-1' },
            },
            { id: 'm3', type: 'userMessage', text: ' '.repeat(3) },
        ];
        expect(readWaitingChats([source('a', { items })], sessionOf)[0]?.prompt).toBe('Set up CI');
    });

    it('clips the quoted message and caps how many Chats it lists', () => {
        const items: AgentChatItem[] = [
            {
                id: 'm1',
                type: 'userMessage',
                text: 'x'.repeat(AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH * 2),
            },
        ];
        const many = Array.from({ length: AGENT_CHAT_WAITING_MAX_CHATS + 5 }, (_, index) =>
            source(`t${index}`, { items }),
        );
        const chats = readWaitingChats(many, sessionOf);
        expect(chats).toHaveLength(AGENT_CHAT_WAITING_MAX_CHATS);
        expect(chats[0]?.prompt).toHaveLength(AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH);
    });
});
