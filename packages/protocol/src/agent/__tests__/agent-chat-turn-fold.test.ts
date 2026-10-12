import { describe, expect, it } from 'vitest';

import type { AgentChatItem } from '../agent-chat-contract';
import { agentChatFinalReplyId, foldAgentChatTurn } from '../agent-chat-turn-fold';

const user: AgentChatItem = { id: 'u1', type: 'userMessage', text: 'Fix it' };
const reasoning: AgentChatItem = { id: 'r1', type: 'reasoning', text: 'Looking', streaming: false };
const command: AgentChatItem = {
    id: 'c1',
    type: 'command',
    command: 'ls',
    output: '',
    status: 'completed',
};
const commentary: AgentChatItem = {
    id: 'a1',
    type: 'agentMessage',
    text: 'Checking the tests.',
    streaming: false,
};
const reply: AgentChatItem = { id: 'a2', type: 'agentMessage', text: 'Done.', streaming: false };
const retrying: AgentChatItem = { id: 'n1', type: 'notice', kind: 'retrying' };
const compacted: AgentChatItem = { id: 'n2', type: 'notice', kind: 'compacted' };

const shape = (parts: ReturnType<typeof foldAgentChatTurn>) =>
    parts.map((part) =>
        part.kind === 'kept'
            ? part.item.id
            : `fold(${part.items.map((item) => item.id).join(',')})`,
    );

describe('agentChatFinalReplyId', () => {
    it('names the last visible Agent message and skips an empty one', () => {
        const empty: AgentChatItem = {
            id: 'a3',
            type: 'agentMessage',
            text: ' ',
            streaming: false,
        };
        expect(agentChatFinalReplyId([user, commentary, reply, empty, command])).toBe('a2');
        expect(agentChatFinalReplyId([user, command])).toBeUndefined();
    });
});

describe('foldAgentChatTurn', () => {
    it('folds work and commentary at the first folded position and keeps prompt, reply, and notices', () => {
        const items = [user, reasoning, retrying, commentary, command, compacted, reply];
        expect(shape(foldAgentChatTurn(items, 'a2'))).toEqual([
            'u1',
            'fold(r1,n1,a1,c1)',
            'n2',
            'a2',
        ]);
    });

    it('folds every reply when the turn has no final reply, as a stopped turn', () => {
        expect(shape(foldAgentChatTurn([user, commentary, command], undefined))).toEqual([
            'u1',
            'fold(a1,c1)',
        ]);
    });

    it('keeps everything when there is nothing to fold', () => {
        expect(shape(foldAgentChatTurn([user, reply], 'a2'))).toEqual(['u1', 'a2']);
    });
});
