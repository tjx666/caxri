import { describe, expect, it } from 'vitest';

import {
    agentChatImageDataUri,
    agentChatViewerAccessibility,
    agentChatViewerAccessibilitySwipe,
    agentChatViewerContent,
    agentChatViewerPage,
    agentChatViewerPosition,
    agentChatViewerSwipe,
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

describe('Agent Chat image viewer gestures', () => {
    const viewport = { width: 400, height: 800 };
    const drag = (translationX: number, translationY: number, velocityX = 0, velocityY = 0) => ({
        translationX,
        translationY,
        velocityX,
        velocityY,
    });

    it('closes on a long or quick downward drag', () => {
        expect(agentChatViewerSwipe(drag(10, 200), viewport)).toBe('dismiss');
        expect(agentChatViewerSwipe(drag(0, 60, 0, 1_200), viewport)).toBe('dismiss');
        expect(agentChatViewerSwipe(drag(0, 60), viewport)).toBeNull();
        // An upward drag does nothing.
        expect(agentChatViewerSwipe(drag(0, -300, 0, -1_200), viewport)).toBeNull();
    });

    it('turns the page on a long or quick sideways drag', () => {
        expect(agentChatViewerSwipe(drag(-120, 10), viewport)).toBe('next');
        expect(agentChatViewerSwipe(drag(120, 10), viewport)).toBe('previous');
        expect(agentChatViewerSwipe(drag(-40, 0, -1_000), viewport)).toBe('next');
        expect(agentChatViewerSwipe(drag(-40, 0), viewport)).toBeNull();
        // A fling back toward the start cancels a drag.
        expect(agentChatViewerSwipe(drag(-40, 0, 1_000), viewport)).toBeNull();
    });

    it('stays within the message and counts its images', () => {
        expect(agentChatViewerPage(0, 3, 'next')).toBe(1);
        expect(agentChatViewerPage(0, 3, 'previous')).toBeNull();
        expect(agentChatViewerPage(2, 3, 'next')).toBeNull();
        expect(agentChatViewerPosition(1, 3)).toBe('2 / 3');
        expect(agentChatViewerPosition(0, 1)).toBeNull();
    });
});

describe('Agent Chat image viewer accessibility', () => {
    it('offers adjust actions only toward an image that exists, with a hint naming them', () => {
        const middle = agentChatViewerAccessibility({ next: true, previous: true });
        expect(middle.role).toBe('adjustable');
        expect(middle.actions.map(({ name }) => name)).toEqual(['increment', 'decrement']);
        expect(middle.hint).toContain('Swipe up or down');
        expect(
            agentChatViewerAccessibility({ next: false, previous: true }).actions.map(
                ({ name }) => name,
            ),
        ).toEqual(['decrement']);
        const single = agentChatViewerAccessibility({ next: false, previous: false });
        expect(single).toEqual({
            actions: [],
            hint: 'Pinch or double-tap to zoom.',
            role: 'image',
        });
    });

    it('turns increment to the next image and decrement to the previous one', () => {
        expect(agentChatViewerAccessibilitySwipe('increment')).toBe('next');
        expect(agentChatViewerAccessibilitySwipe('decrement')).toBe('previous');
        expect(agentChatViewerAccessibilitySwipe('activate')).toBeNull();
    });
});
