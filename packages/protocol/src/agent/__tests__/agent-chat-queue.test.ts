import { describe, expect, it } from 'vitest';

import { agentChatQueueEntry } from '../agent-chat-queue.js';

const queue = [
    { id: 'a', text: 'Then run\n  the tests' },
    { id: 'b', text: 'Compare', imageCount: 2 },
    { id: 'c', text: '', imageCount: 1 },
    { id: 'd', text: '', command: { name: 'review', arguments: 'src' } },
    { id: 'e', text: '', command: { name: 'compact' } },
];

const entries = (isTurnRunning: boolean) =>
    queue.map((message) => agentChatQueueEntry(message, isTurnRunning));

describe('agentChatQueueEntry', () => {
    it('names each queued message with its command and image count', () => {
        expect(
            entries(false).map(({ id, preview, commandLabel, imageLabel }) => ({
                id,
                preview,
                commandLabel,
                imageLabel,
            })),
        ).toEqual([
            {
                id: 'a',
                preview: 'Then run the tests',
                commandLabel: undefined,
                imageLabel: undefined,
            },
            { id: 'b', preview: 'Compare', commandLabel: undefined, imageLabel: '2 images' },
            { id: 'c', preview: '', commandLabel: undefined, imageLabel: '1 image' },
            { id: 'd', preview: 'src', commandLabel: '/review', imageLabel: undefined },
            { id: 'e', preview: '', commandLabel: '/compact', imageLabel: undefined },
        ]);
    });

    it('steers during a turn but keeps a command waiting for its own', () => {
        const running = entries(true);
        expect(running.map((entry) => entry.sendNowLabel)).toEqual(
            Array.from({ length: 5 }, () => 'Steer'),
        );
        expect(running.map((entry) => entry.canSendNow)).toEqual([true, true, true, false, false]);
        const idle = entries(false);
        expect(idle.map((entry) => entry.sendNowLabel)).toEqual(
            Array.from({ length: 5 }, () => 'Send now'),
        );
        expect(idle.every((entry) => entry.canSendNow)).toBe(true);
    });

    it('edits any message, including one carrying images (in place)', () => {
        expect(entries(true).every((entry) => entry.canEdit)).toBe(true);
    });
});
