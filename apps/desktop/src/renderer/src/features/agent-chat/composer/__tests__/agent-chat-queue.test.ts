import { describe, expect, it } from 'vitest';

import {
    agentChatNextQueuedId,
    agentChatQueueCardLabels,
    agentChatQueuedTextAfterEdit,
    agentChatQueuedTextEdit,
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
    const message = { commandLabel: undefined };
    const command = { commandLabel: '/compact' };

    it('tells a failed send from a Stop and offers Retry for it', () => {
        expect(
            agentChatQueueHeader({ queuePaused: true, queuePauseReason: 'sendFailed' }, false, [
                message,
            ]),
        ).toEqual({ tone: 'failed', text: "Couldn't send queued messages", resumeLabel: 'Retry' });
        expect(
            agentChatQueueHeader({ queuePaused: true, queuePauseReason: 'stopped' }, false, [
                message,
            ]),
        ).toEqual({
            tone: 'paused',
            text: 'Queue paused · sends nothing until you resume',
            resumeLabel: 'Resume',
        });
        expect(
            agentChatQueueHeader({ queuePaused: true, queuePauseReason: 'deliveryUnknown' }, true, [
                message,
            ]),
        ).toMatchObject({ tone: 'paused', resumeLabel: 'Resume' });
    });

    it('says the leading messages go out together only when Server Core joins them', () => {
        expect(agentChatQueueHeader(undefined, true, [message, message])).toEqual({
            tone: 'normal',
            text: 'Queued · sends together after this turn',
        });
        expect(agentChatQueueHeader(undefined, true, [message]).text).toBe(
            'Queued · sends after this turn',
        );
        expect(agentChatQueueHeader(undefined, true, [command, message]).text).toBe(
            'Queued · sends after this turn',
        );
        expect(agentChatQueueHeader({ queuePaused: false }, false, [message, message]).text).toBe(
            'Queued',
        );
    });
});

describe('agentChatQueueCardLabels', () => {
    const message = { canSendNow: true, sendNowLabel: 'Steer' as const };

    it('names each action, steering while a turn runs', () => {
        expect(agentChatQueueCardLabels(message)).toEqual({
            editTooltip: 'Edit',
            deleteTooltip: 'Delete',
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
            editTooltip: 'Edit',
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
            editTooltip: 'Sending…',
            deleteTooltip: 'Sending…',
            sendTooltip: 'Sending…',
            sendAriaLabel: 'Steer now',
        });
    });
});

describe('agentChatQueuedTextEdit', () => {
    it('edits only what the user typed and keeps the cited files ahead of it', () => {
        const text =
            '# Files mentioned by the user:\n\n## a.ts: /tmp/a.ts\n\n## My request:\nlook here';
        const { prefix, body } = agentChatQueuedTextEdit(text);
        expect(body).toBe('look here');
        expect(agentChatQueuedTextAfterEdit(prefix, 'look there')).toBe(
            '# Files mentioned by the user:\n\n## a.ts: /tmp/a.ts\n\n## My request:\nlook there',
        );
    });

    it('treats plain text as all body', () => {
        expect(agentChatQueuedTextEdit('plain')).toEqual({ prefix: '', body: 'plain' });
    });
});
