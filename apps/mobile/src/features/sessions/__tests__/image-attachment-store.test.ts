import { describe, expect, it, vi } from 'vitest';

import type { ImageAttachment } from '../image-attachment-store';
import {
    completeImageAttachment,
    imageAttachmentAccessibilityLabel,
    imageAttachmentKey,
    ImageAttachmentStore,
    imageAttachmentWaitReason,
    patchImageAttachment,
    removeImageAttachment,
} from '../image-attachment-store';

const attachment = (patch: Partial<ImageAttachment> = {}): ImageAttachment => ({
    id: 'image_a',
    uri: 'file:///a.jpg',
    progress: 0,
    state: 'uploading',
    base64: 'QUJD',
    ...patch,
});

describe('composer image attachment store', () => {
    it('keeps pending images per key after every subscriber left, as a composer remount needs', () => {
        const store = new ImageAttachmentStore();
        const key = imageAttachmentKey('scope', 'chat', 'session_1');
        const listener = vi.fn();
        const unsubscribe = store.subscribe(key, listener);
        store.update(key, (current) => [...current, attachment()]);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        // An upload still running after the composer unmounted keeps reporting into the store.
        store.update(key, (current) => patchImageAttachment(current, 'image_a', { progress: 0.5 }));
        expect(store.get(key)).toEqual([attachment({ progress: 0.5 })]);
        expect(store.get(imageAttachmentKey('scope', 'chat', 'session_2'))).toEqual([]);
        expect(store.get(imageAttachmentKey('scope', 'terminal', 'session_1'))).toEqual([]);
    });

    it('skips notifying when a change leaves the list as it was', () => {
        const store = new ImageAttachmentStore();
        const listener = vi.fn();
        store.subscribe('key', listener);
        store.update('key', (current) => removeImageAttachment(current, 'missing'));
        store.update('key', (current) => patchImageAttachment(current, 'missing', { progress: 1 }));
        expect(listener).not.toHaveBeenCalled();
    });

    it('remembers a cancelled upload so its next chunk stops', () => {
        const store = new ImageAttachmentStore();
        expect(store.isCancelled('image_a')).toBe(false);
        store.cancel('image_a');
        expect(store.isCancelled('image_a')).toBe(true);
    });

    it('drops the uploaded bytes once an image is ready', () => {
        const ready = completeImageAttachment(
            [attachment({ thumbnail: { id: 'image_t', base64: 'REVG' } })],
            'image_a',
        );
        expect(ready).toEqual([
            {
                id: 'image_a',
                uri: 'file:///a.jpg',
                progress: 1,
                state: 'ready',
                thumbnail: { id: 'image_t' },
            },
        ]);
    });
});

describe('composer image attachment copy', () => {
    it('explains why Send waits, and that a failed image blocks it', () => {
        expect(imageAttachmentWaitReason([])).toBeNull();
        expect(imageAttachmentWaitReason([attachment({ state: 'ready' })])).toBeNull();
        expect(imageAttachmentWaitReason([attachment({ state: 'preparing' })])).toBe(
            'Waiting for images to upload…',
        );
        expect(
            imageAttachmentWaitReason([
                attachment({ state: 'uploading' }),
                attachment({ id: 'image_b', state: 'failed' }),
            ]),
        ).toBe("An image didn't upload. Tap it to retry or remove it.");
    });

    it('names each thumbnail by its place in the strip and its state', () => {
        expect(imageAttachmentAccessibilityLabel(attachment({ state: 'ready' }), 0, 3)).toBe(
            'Image 1 of 3',
        );
        expect(imageAttachmentAccessibilityLabel(attachment({ state: 'preparing' }), 1, 3)).toBe(
            'Image 2 of 3, preparing',
        );
        expect(imageAttachmentAccessibilityLabel(attachment({ progress: 0.42 }), 2, 3)).toBe(
            'Image 3 of 3, uploading 42%',
        );
        expect(imageAttachmentAccessibilityLabel(attachment({ state: 'failed' }), 0, 1)).toBe(
            'Image 1 of 1, upload failed',
        );
    });
});
