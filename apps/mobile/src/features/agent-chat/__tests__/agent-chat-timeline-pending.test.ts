import { describe, expect, it } from 'vitest';

import {
    buildAgentChatTimeline,
    withAgentChatAwaitingReply,
    withAgentChatPendingEntries,
} from '../agent-chat-timeline';

describe('withAgentChatPendingEntries', () => {
    it('ends the timeline with recorded answers, then the messages still on their way', () => {
        const built = buildAgentChatTimeline({ items: [], turns: [] });
        expect(withAgentChatPendingEntries(built, { notices: [], timeline: [] })).toBe(built);
        const entries = withAgentChatPendingEntries(built, {
            notices: [
                { id: 'answer:r1', type: 'notice', kind: 'answered', message: 'Color: Blue' },
            ],
            timeline: [
                { id: 'p1', text: 'Run the tests', imageUris: ['file:///a.jpg'] },
                { id: 'p2', text: 'Also lint', imageUris: [], wait: 'step' },
            ],
        });
        expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
            ['message', 'pending:answer:r1'],
            ['pending', 'pending:p1'],
            ['pending', 'pending:p2'],
        ]);
        expect(entries.at(-2)).toMatchObject({
            text: 'Run the tests',
            imageUris: ['file:///a.jpg'],
            wait: 'delivery',
        });
        expect(entries.at(-1)).toMatchObject({ wait: 'step' });
    });
});

describe('withAgentChatAwaitingReply', () => {
    const prompt = {
        kind: 'message',
        id: 'u1',
        message: { id: 'u1', type: 'userMessage', text: 'hi' },
    } as const;
    const reply = {
        kind: 'message',
        id: 'a1',
        message: { id: 'a1', type: 'agentMessage', text: 'hello' },
    } as const;
    const running = { activeTurnId: 't1', requests: [] };

    it('holds the reply place under the prompt while the running turn shows nothing', () => {
        expect(withAgentChatAwaitingReply([prompt], running).map(({ kind }) => kind)).toEqual([
            'message',
            'awaiting',
        ]);
    });

    it('shows nothing once the turn has output, is idle, asks, or compacts', () => {
        const entries = [prompt];
        expect(withAgentChatAwaitingReply([prompt, reply], running)).toHaveLength(2);
        expect(withAgentChatAwaitingReply(entries, { requests: [] })).toBe(entries);
        expect(withAgentChatAwaitingReply(entries, undefined)).toBe(entries);
        expect(withAgentChatAwaitingReply(entries, { ...running, operation: 'compacting' })).toBe(
            entries,
        );
        expect(
            withAgentChatAwaitingReply(entries, {
                ...running,
                requests: [{ id: 'r1' } as never],
            }),
        ).toBe(entries);
    });
});
