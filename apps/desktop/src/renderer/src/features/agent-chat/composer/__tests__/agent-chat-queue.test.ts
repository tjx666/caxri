import { describe, expect, it } from 'vitest';

import {
    agentChatNextQueuedId,
    agentChatQueueCardLabels,
    agentChatQueueDeleteOutcome,
    agentChatQueueEntries,
    agentChatQueueHeader,
} from '../agent-chat-queue';

describe('agentChatQueueEntries', () => {
    it('adds Edit to the shared row, including a message carrying images (edited in place)', () => {
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
        expect(withImages).toMatchObject({
            imageLabel: '2 images',
            imageCount: 2,
            text: 'Look at this',
            canEdit: true,
        });
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

describe('agentChatNextQueuedId', () => {
    const command = {
        id: 'c1',
        text: '/compact',
        command: { name: 'compact' },
    };

    it('picks the head of the queue, unless a running turn makes that command wait', () => {
        expect(agentChatNextQueuedId(undefined, true)).toBeUndefined();
        expect(agentChatNextQueuedId([], false)).toBeUndefined();
        expect(
            agentChatNextQueuedId(
                [
                    { id: 'm1', text: 'first' },
                    { id: 'm2', text: 'second' },
                ],
                true,
            ),
        ).toBe('m1');
        expect(agentChatNextQueuedId([command, { id: 'm1', text: 'later' }], true)).toBeUndefined();
        expect(agentChatNextQueuedId([command], false)).toBe('c1');
    });
});

describe('agentChatQueueHeader', () => {
    it('tells a failed send from a Stop and offers Retry for it', () => {
        expect(agentChatQueueHeader({ queuePaused: true, queuePauseReason: 'sendFailed' })).toEqual(
            {
                tone: 'failed',
                text: "Couldn't send queued messages",
                resumeLabel: 'Retry',
            },
        );
        expect(agentChatQueueHeader({ queuePaused: true, queuePauseReason: 'stopped' })).toEqual({
            tone: 'paused',
            text: 'Queue paused · sends nothing until you resume',
            resumeLabel: 'Resume',
        });
        expect(
            agentChatQueueHeader({ queuePaused: true, queuePauseReason: 'deliveryUnknown' }),
        ).toMatchObject({ tone: 'paused', resumeLabel: 'Resume' });
        expect(agentChatQueueHeader({ queuePaused: true, queuePauseReason: 'usageGuard' })).toEqual(
            {
                tone: 'paused',
                text: 'Queue paused · weekly usage nearly used up',
                resumeLabel: 'Resume',
            },
        );
    });

    it('heads a waiting queue with nothing', () => {
        expect(agentChatQueueHeader(undefined)).toBeUndefined();
        expect(agentChatQueueHeader({ queuePaused: false })).toBeUndefined();
    });
});

describe('agentChatQueueCardLabels', () => {
    const message = { canSendNow: true, sendNowLabel: 'Steer' as const };

    it('names each action, steering while a turn runs', () => {
        expect(agentChatQueueCardLabels(message)).toEqual({
            deleteAriaLabel: 'Delete queued message',
            deleteTooltip: 'Delete',
            editTooltip: 'Edit',
            sendTooltip: 'Add to the running turn now',
            sendAriaLabel: 'Steer now',
        });
        expect(agentChatQueueCardLabels({ ...message, sendNowLabel: 'Send now' })).toMatchObject({
            sendTooltip: 'Send now',
            sendAriaLabel: 'Send now',
        });
    });

    it('says why an action is unavailable', () => {
        expect(agentChatQueueCardLabels({ ...message, canSendNow: false })).toMatchObject({
            sendTooltip: 'A command waits for the running turn to end',
        });
    });

    it('says every action waits while the message is still sending', () => {
        expect(
            agentChatQueueCardLabels({
                ...message,
                canSendNow: false,
                isPending: true,
            }),
        ).toEqual({
            deleteAriaLabel: 'Delete queued message',
            deleteTooltip: 'Sending…',
            editTooltip: 'Sending…',
            sendTooltip: 'Sending…',
            sendAriaLabel: 'Steer now',
        });
    });
});

describe('agentChatQueueDeleteOutcome', () => {
    it('moves the text back into an empty composer so a mis-click is recoverable', () => {
        expect(agentChatQueueDeleteOutcome(true, { imageCount: 0 })).toBe('restore');
    });

    it('deletes outright when the user has a draft, so it is never clobbered', () => {
        expect(agentChatQueueDeleteOutcome(false, { imageCount: 0 })).toBe('drop');
    });

    it('deletes outright a message whose images cannot return to the composer', () => {
        expect(agentChatQueueDeleteOutcome(true, { imageCount: 2 })).toBe('drop');
    });

    it('words the delete tooltip and accessible name by the outcome', () => {
        const entry = { canSendNow: true, sendNowLabel: 'Steer' as const };
        expect(agentChatQueueCardLabels(entry, undefined, 'restore')).toMatchObject({
            deleteAriaLabel: 'Move queued message back to the composer',
            deleteTooltip: 'Remove from the queue and move back to the composer',
        });
        expect(agentChatQueueCardLabels(entry, undefined, 'drop')).toMatchObject({
            deleteAriaLabel: 'Delete queued message',
            deleteTooltip: 'Delete',
        });
    });
});
