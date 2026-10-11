import { describe, expect, it } from 'vitest';

import { agentChatQueueCaption, agentChatQueueRows } from '../agent-chat-queue';

describe('agentChatQueueRows', () => {
    it('names each queued message in one line, in send order', () => {
        expect(
            agentChatQueueRows({
                queue: [
                    { id: 'a', text: 'Then run\n  the tests' },
                    { id: 'b', text: 'Compare', imageCount: 2 },
                    { id: 'c', text: '', imageCount: 1 },
                    { id: 'd', text: '', command: { name: 'review', arguments: 'src' } },
                    { id: 'e', text: '', command: { name: 'compact' } },
                ],
            }),
        ).toEqual([
            { id: 'a', text: 'Then run the tests' },
            { id: 'b', text: 'Compare', images: '2 images' },
            { id: 'c', text: '1 image' },
            { id: 'd', text: '/review src' },
            { id: 'e', text: '/compact' },
        ]);
        expect(agentChatQueueRows(undefined)).toEqual([]);
        expect(agentChatQueueRows({})).toEqual([]);
    });
});

describe('agentChatQueueCaption', () => {
    it('captions a waiting queue and says where to resume a paused one', () => {
        expect(agentChatQueueCaption({ queue: [] })).toBeUndefined();
        expect(agentChatQueueCaption({ queue: [{ id: 'a', text: 'x' }] })).toBe('Queued');
        expect(agentChatQueueCaption({ queue: [{ id: 'a', text: 'x' }], queuePaused: true })).toBe(
            'Queued, paused. Resume on your computer.',
        );
    });
});
