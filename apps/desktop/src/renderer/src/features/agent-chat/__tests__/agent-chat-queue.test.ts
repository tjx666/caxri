import { describe, expect, it } from 'vitest';

import { agentChatQueueEntries, draftAfterQueueEdit } from '../agent-chat-queue';

describe('agentChatQueueEntries', () => {
    const queue = [
        { id: 'm1', text: 'Then run the tests' },
        { id: 'm2', text: 'Look at this', imageCount: 2 },
        {
            id: 'c1',
            text: '/compact keep the plan',
            command: { name: 'compact', arguments: 'keep the plan' },
        },
    ];

    it('offers Steer while a turn runs, except for a command', () => {
        const [message, withImages, command] = agentChatQueueEntries(queue, true);
        expect(message).toMatchObject({
            preview: 'Then run the tests',
            sendNowLabel: 'Steer',
            canSendNow: true,
            canEdit: true,
            editText: 'Then run the tests',
        });
        expect(withImages).toMatchObject({ imageLabel: '2 images', canEdit: false });
        expect(command).toMatchObject({
            preview: 'keep the plan',
            commandLabel: '/compact',
            canSendNow: false,
            editText: '/compact keep the plan',
        });
    });

    it('offers Send now for every entry while the Chat is idle', () => {
        const entries = agentChatQueueEntries(queue, false);
        expect(
            entries.every((entry) => entry.sendNowLabel === 'Send now' && entry.canSendNow),
        ).toBe(true);
        expect(
            agentChatQueueEntries([{ id: 'm', text: 'x', imageCount: 1 }], false)[0]?.imageLabel,
        ).toBe('1 image');
        expect(agentChatQueueEntries(undefined, false)).toEqual([]);
    });
});

describe('draftAfterQueueEdit', () => {
    it('restores the message, ahead of anything already typed', () => {
        expect(draftAfterQueueEdit('', 'queued')).toBe('queued');
        expect(draftAfterQueueEdit('  ', 'queued')).toBe('queued');
        expect(draftAfterQueueEdit('typed', 'queued')).toBe('queued\ntyped');
    });
});
