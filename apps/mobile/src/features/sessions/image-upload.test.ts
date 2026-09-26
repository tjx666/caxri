import { describe, expect, it, vi } from 'vitest';

import { didUploadImageChunks } from './image-upload';

describe('didUploadImageChunks', () => {
    it('sends chunks in order and reports progress after acknowledgement', async () => {
        const events: string[] = [];
        const send = vi.fn((index: number) => {
            events.push(`send:${index}`);
            return Promise.resolve();
        });
        const completed = await didUploadImageChunks(
            ['first', 'second'],
            send,
            () => false,
            (progress) => events.push(`progress:${progress}`),
        );

        expect(completed).toBe(true);
        expect(send.mock.calls).toEqual([
            [0, 'first', 2],
            [1, 'second', 2],
        ]);
        expect(events).toEqual(['send:0', 'progress:0.5', 'send:1', 'progress:1']);
    });

    it('stops before the next chunk after cancellation', async () => {
        let isCancelled = false;
        const send = vi.fn(() => {
            isCancelled = true;
            return Promise.resolve();
        });
        const completed = await didUploadImageChunks(
            ['first', 'second'],
            send,
            () => isCancelled,
            () => {},
        );

        expect(completed).toBe(false);
        expect(send).toHaveBeenCalledOnce();
    });
});
