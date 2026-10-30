import {
    applyAgentChatOperation,
    emptyAgentChatSnapshot,
    MAX_AGENT_CHAT_ITEMS,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { historyOperations, itemTimeOperations } from '../turns';

const TEXT = [{ type: 'text', text: 'hello' }];

describe('historyOperations', () => {
    it('keeps the projection marked truncated when resumed history overflows the item budget', () => {
        const items = Array.from({ length: MAX_AGENT_CHAT_ITEMS + 5 }, (_, index) => ({
            id: `m${index}`,
            type: 'agentMessage',
            text: 'reply',
        }));
        const operations = historyOperations(
            { turns: [{ id: 'turn-1', status: 'completed', items }] },
            undefined,
        );
        const snapshot = operations.reduce(
            applyAgentChatOperation,
            emptyAgentChatSnapshot('terminal-1'),
        );
        expect(snapshot.items).toHaveLength(MAX_AGENT_CHAT_ITEMS);
        expect(snapshot.truncated).toBe(true);
    });

    it('names the subagent a resumed wait waited for, even in a later turn', () => {
        const spawn = {
            type: 'collabAgentToolCall',
            id: 's',
            tool: 'spawnAgent',
            status: 'completed',
            receiverThreadIds: ['child'],
            prompt: 'Review the diff\nand report back.',
        };
        const wait = { ...spawn, id: 'w', tool: 'wait', prompt: null };
        const operations = historyOperations(
            {
                turns: [
                    { id: 'turn-1', status: 'completed', items: [spawn] },
                    { id: 'turn-2', status: 'completed', items: [wait] },
                ],
            },
            undefined,
        );
        const snapshot = operations.reduce(
            applyAgentChatOperation,
            emptyAgentChatSnapshot('terminal-1'),
        );
        expect(snapshot.items.find((item) => item.id === 'w')).toMatchObject({
            summary: 'Review the diff',
        });
    });

    it('resumes a short history untruncated', () => {
        const operations = historyOperations(
            {
                turns: [
                    {
                        id: 'turn-1',
                        status: 'completed',
                        items: [{ id: 'm', type: 'agentMessage', text: 'hi' }],
                    },
                ],
            },
            undefined,
        );
        const snapshot = operations.reduce(
            applyAgentChatOperation,
            emptyAgentChatSnapshot('terminal-1'),
        );
        expect(snapshot.truncated).toBe(false);
        expect(snapshot.items).toHaveLength(1);
    });

    it('dates a resumed user message by the start of its turn', () => {
        const operations = historyOperations(
            {
                turns: [
                    {
                        id: 'turn-1',
                        status: 'completed',
                        startedAt: 1_760_000_000,
                        items: [
                            { id: 'u', type: 'userMessage', clientId: null, content: TEXT },
                            { id: 'm', type: 'agentMessage', text: 'hi' },
                            { id: 's', type: 'userMessage', clientId: 'steered:1', content: TEXT },
                        ],
                    },
                    {
                        id: 'turn-2',
                        status: 'completed',
                        items: [{ id: 'u2', type: 'userMessage', content: TEXT }],
                    },
                ],
            },
            undefined,
        );
        const snapshot = operations.reduce(
            applyAgentChatOperation,
            emptyAgentChatSnapshot('terminal-1'),
        );
        expect(snapshot.items.map((item) => [item.id, item.createdAt])).toEqual([
            ['u', 1_760_000_000_000],
            ['m', undefined],
            // A message steered in later did not start the turn, so it waits for its own time.
            ['s', undefined],
            // A turn without a recorded start leaves its message undated rather than guessed.
            ['u2', undefined],
        ]);
    });
});

describe('itemTimeOperations', () => {
    it('dates only undated items that Codex reports a start for', () => {
        const snapshot = {
            ...emptyAgentChatSnapshot('terminal-1'),
            items: [
                { id: 'u', type: 'userMessage' as const, text: 'hi', createdAt: 5 },
                { id: 'm', type: 'agentMessage' as const, text: 'hello', streaming: false },
                { id: 'r', type: 'reasoning' as const, text: 'think', streaming: false },
            ],
        };
        const operations = itemTimeOperations(snapshot, [
            { turnId: 't', item: { id: 'u', type: 'userMessage' }, startedAtMs: 9 },
            { turnId: 't', item: { id: 'm', type: 'agentMessage' }, startedAtMs: 7 },
            { turnId: 't', item: { id: 'r', type: 'reasoning' }, startedAtMs: null },
            'not an entry',
        ]);
        expect(operations).toEqual([
            {
                op: 'upsertItem',
                item: {
                    id: 'm',
                    type: 'agentMessage',
                    text: 'hello',
                    streaming: false,
                    createdAt: 7,
                },
            },
        ]);
    });
});
