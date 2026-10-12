import { describe, expect, it } from 'vitest';

import { agentChatQueueEntries } from '../agent-chat-queue';

describe('agentChatQueueEntries', () => {
    it('adds Edit to the shared row, except for a message carrying images', () => {
        const [message, withImages, command] = agentChatQueueEntries(
            [
                { id: 'm1', text: 'Then run the tests' },
                { id: 'm2', text: 'Look at this', imageCount: 2 },
                {
                    id: 'c1',
                    text: '/compact keep the plan',
                    command: { name: 'compact', arguments: 'keep the plan' },
                },
            ],
            true,
        );
        expect(message).toMatchObject({
            preview: 'Then run the tests',
            sendNowLabel: 'Steer',
            canEdit: true,
        });
        expect(withImages).toMatchObject({ imageLabel: '2 images', canEdit: false });
        expect(command).toMatchObject({
            commandLabel: '/compact',
            canSendNow: false,
            canEdit: true,
        });
        expect(agentChatQueueEntries(undefined, false)).toEqual([]);
    });

    it('lists messages still on their way after the queue, with every action held', () => {
        const entries = agentChatQueueEntries([{ id: 'm1', text: 'Queued' }], true, [
            {
                id: 'p1',
                text: 'On its way',
                images: [{ thumbnail: '' }],
                placement: 'queue',
                knownIds: new Set(),
            },
        ]);
        expect(entries.map((entry) => entry.id)).toEqual(['m1', 'p1']);
        expect(entries[0]?.isPending).toBeUndefined();
        expect(entries[1]).toMatchObject({
            preview: 'On its way',
            imageLabel: '1 image',
            isPending: true,
            canEdit: false,
            canSendNow: false,
        });
    });
});
