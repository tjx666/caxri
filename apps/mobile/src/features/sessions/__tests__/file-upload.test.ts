import { Buffer } from 'node:buffer';

import { MOBILE_FILE_CHUNK_BYTES } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { encodeBase64, uploadFileChunks } from '../file-upload';

describe('encodeBase64', () => {
    it.each([0, 1, 2, 3, 4, 5, 255, 1_000])('matches Node for %i bytes', (length) => {
        const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256);
        expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    });
});

describe('uploadFileChunks', () => {
    it('sends every chunk once, several at a time, and resolves the path the last chunk returns', async () => {
        const size = MOBILE_FILE_CHUNK_BYTES * 9 + 1;
        const sent: number[] = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const progress: number[] = [];
        const path = await uploadFileChunks({
            size,
            isCancelled: () => false,
            onProgress: (value) => progress.push(value),
            readChunk: (index) => `chunk-${index}`,
            sendChunk: async (index, chunk) => {
                expect(chunk).toBe(`chunk-${index}`);
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 1));
                inFlight -= 1;
                sent.push(index);
                return sent.length === 10
                    ? { ready: true, path: '/tmp/file_x/clip.mov' }
                    : { ready: false };
            },
        });
        expect(path).toBe('/tmp/file_x/clip.mov');
        expect(sent.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(maxInFlight).toBeGreaterThan(1);
        expect(progress.at(-1)).toBe(1);
    });

    it('sends an empty file as its one empty chunk', async () => {
        const sendChunk = vi.fn(() =>
            Promise.resolve({ ready: true, path: '/tmp/file_y/empty.txt' }),
        );
        await expect(
            uploadFileChunks({
                size: 0,
                isCancelled: () => false,
                onProgress: () => {},
                readChunk: () => '',
                sendChunk,
            }),
        ).resolves.toBe('/tmp/file_y/empty.txt');
        expect(sendChunk).toHaveBeenCalledExactlyOnceWith(0, '');
    });

    it('stops sending after a cancel or a failed chunk', async () => {
        let isCancelled = false;
        const sendChunk = vi.fn((index: number) => {
            if (index === 1) isCancelled = true;
            return Promise.resolve({ ready: false });
        });
        await expect(
            uploadFileChunks({
                size: MOBILE_FILE_CHUNK_BYTES * 40,
                isCancelled: () => isCancelled,
                onProgress: () => {},
                readChunk: () => 'x',
                sendChunk,
            }),
        ).resolves.toBeUndefined();
        expect(sendChunk.mock.calls.length).toBeLessThan(10);

        const failing = vi.fn(() => Promise.reject(new Error('offline')));
        await expect(
            uploadFileChunks({
                size: MOBILE_FILE_CHUNK_BYTES * 40,
                isCancelled: () => false,
                onProgress: () => {},
                readChunk: () => 'x',
                sendChunk: failing,
            }),
        ).rejects.toThrow('offline');
        expect(failing.mock.calls.length).toBeLessThan(10);
    });
});
