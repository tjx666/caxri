import { describe, expect, it } from 'vitest';

import { agentChatQueueEntries, draftAfterQueueEdit } from '../agent-chat-queue';

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
            editText: 'Then run the tests',
        });
        expect(withImages).toMatchObject({ imageLabel: '2 images', canEdit: false });
        expect(command).toMatchObject({
            commandLabel: '/compact',
            canSendNow: false,
            editText: '/compact keep the plan',
        });
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
