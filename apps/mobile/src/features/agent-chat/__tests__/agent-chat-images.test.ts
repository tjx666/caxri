import { describe, expect, it } from 'vitest';

import {
    agentChatImageDataUri,
    agentChatViewerContent,
    clampZoomPan,
    readAgentChatImage,
} from '../agent-chat-images';

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

describe('Agent Chat image viewer', () => {
    it('keeps a zoomed pan within the picture edges', () => {
        expect(clampZoomPan(120, 1, 400)).toBe(0);
        expect(clampZoomPan(150, 2, 400)).toBe(150);
        expect(clampZoomPan(500, 2, 400)).toBe(200);
        expect(clampZoomPan(-500, 2, 400)).toBe(-200);
        expect(clampZoomPan(30, 0.8, 400)).toBe(0);
    });

    const loading = { uri: null, isMissing: false, isError: false };

    it('shows the cached thumbnail while the original loads', () => {
        expect(agentChatViewerContent(loading, 'data:thumb')).toEqual({
            imageUri: null,
            isPreview: false,
            placeholderUri: 'data:thumb',
            message: null,
        });
        expect(
            agentChatViewerContent({ ...loading, uri: 'file:///full.png' }, 'data:thumb'),
        ).toEqual({
            imageUri: 'file:///full.png',
            isPreview: false,
            placeholderUri: null,
            message: null,
        });
    });

    it('falls back to a preview, or says the image is gone', () => {
        expect(agentChatViewerContent({ ...loading, isMissing: true }, 'data:thumb')).toEqual({
            imageUri: 'data:thumb',
            isPreview: true,
            placeholderUri: null,
            message: null,
        });
        expect(agentChatViewerContent({ ...loading, isMissing: true }, null).message).toBe(
            'This image is no longer available.',
        );
        expect(agentChatViewerContent({ ...loading, isError: true }, 'data:thumb')).toEqual({
            imageUri: null,
            isPreview: false,
            placeholderUri: 'data:thumb',
            message: 'The image could not be loaded.',
        });
    });
});
