import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatSettledChunks, chunkAgentChatHistory } from '../agent-chat-settled-chunks';

function turnItems(index: number): AgentChatItem[] {
    return [
        { id: `u${index}`, turnId: `t${index}`, type: 'userMessage', text: `Question ${index}` },
        {
            id: `a${index}`,
            turnId: `t${index}`,
            type: 'agentMessage',
            text: `Answer ${index}`,
            streaming: false,
        },
    ];
}

const items = Array.from({ length: 400 }, (_, index) => turnItems(index)).flat();
const turns: AgentChatTurn[] = Array.from({ length: 400 }, (_, index) => ({
    id: `t${index}`,
    status: 'completed',
}));

describe('chunkAgentChatHistory', () => {
    it('splits only at turn starts and keeps every item in order', () => {
        const chunks = chunkAgentChatHistory(items);
        expect(chunks.length).toBeGreaterThan(10);
        expect(chunks.flat()).toEqual(items);
        for (const chunk of chunks) expect(chunk[0].type).toBe('userMessage');
    });

    it('keeps the chunks below a page read back above them', () => {
        const before = chunkAgentChatHistory(items.slice(200)).map((chunk) => chunk[0].id);
        const after = chunkAgentChatHistory(items).map((chunk) => chunk[0].id);
        expect(after.slice(-before.length + 1)).toEqual(before.slice(1));
    });
});

describe('agentChatSettledChunks', () => {
    it('returns the same chunk objects for chunks a page or a kept item did not touch', () => {
        const first = agentChatSettledChunks(items.slice(200, 700), turns);
        const next = agentChatSettledChunks(
            [...items.slice(0, 700), ...turnItems(400)],
            [...turns, { id: 't400', status: 'completed' }],
        );
        const unchanged = first.slice(1, -1);
        expect(unchanged.length).toBeGreaterThan(0);
        for (const chunk of unchanged) expect(next).toContain(chunk);
        expect(next).not.toContain(first.at(-1));
    });
});
