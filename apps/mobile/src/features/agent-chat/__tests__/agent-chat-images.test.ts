import { describe, expect, it } from 'vitest';

import { agentChatImageDataUri, readAgentChatImage } from '../agent-chat-images';

describe('Agent Chat image paging', () => {
    it('joins every chunk of an original in order and reports progress', async () => {
        const chunks = ['QUJD', 'REVG', 'Rw=='];
        const progress: number[] = [];
        const image = await readAgentChatImage(
            (chunkIndex) =>
                Promise.resolve({
                    mediaType: 'image/png',
                    data: chunks[chunkIndex],
                    chunkIndex,
                    chunkCount: chunks.length,
                }),
            (value) => progress.push(value),
        );
        expect(image).toEqual({ mediaType: 'image/png', data: 'QUJDREVGRw==' });
        expect(progress).toEqual([1 / 3, 2 / 3, 1]);
        expect(agentChatImageDataUri(image!)).toBe('data:image/png;base64,QUJDREVGRw==');
    });

    it('resolves null for a message without that image', async () => {
        expect(await readAgentChatImage(() => Promise.resolve(null))).toBeNull();
    });

    it('refuses to join chunks of an image that changed while loading', async () => {
        await expect(
            readAgentChatImage((chunkIndex) =>
                Promise.resolve({
                    mediaType: 'image/png',
                    data: 'QUJD',
                    chunkIndex,
                    chunkCount: chunkIndex === 0 ? 2 : 3,
                }),
            ),
        ).rejects.toThrow('The image changed while it was loading.');
    });
});
