import { describe, expect, it, vi } from 'vitest';

import {
    attachmentKey,
    AttachmentStore,
    attachmentsWithReturned,
    patchAttachment,
    removeAttachment,
} from '../attachment-store';
import type { ImageAttachment } from '../image-attachment-store';
import {
    completeImageAttachment,
    expireImageAttachments,
    IMAGE_ATTACHMENT_REUSE_MS,
    imageAttachmentAccessibilityLabel,
    imageAttachmentBudgetNote,
    imageAttachmentsBase64Length,
    imageAttachmentWaitReason,
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
        const store = new AttachmentStore<ImageAttachment>();
        const key = attachmentKey('scope', 'chat', 'session_1');
        const listener = vi.fn();
        const unsubscribe = store.subscribe(key, listener);
        store.update(key, (current) => [...current, attachment()]);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        // An upload still running after the composer unmounted keeps reporting into the store.
        store.update(key, (current) => patchAttachment(current, 'image_a', { progress: 0.5 }));
        expect(store.get(key)).toEqual([attachment({ progress: 0.5 })]);
        expect(store.get(attachmentKey('scope', 'chat', 'session_2'))).toEqual([]);
        expect(store.get(attachmentKey('scope', 'terminal', 'session_1'))).toEqual([]);
    });

    it('skips notifying when a change leaves the list as it was', () => {
        const store = new AttachmentStore<ImageAttachment>();
        const listener = vi.fn();
        store.subscribe('key', listener);
        store.update('key', (current) => removeAttachment(current, 'missing'));
        store.update('key', (current) => patchAttachment(current, 'missing', { progress: 1 }));
        expect(listener).not.toHaveBeenCalled();
    });

    it('remembers a cancelled upload so its next chunk stops', () => {
        const store = new AttachmentStore<ImageAttachment>();
        expect(store.isCancelled('image_a')).toBe(false);
        store.cancel('image_a');
        expect(store.isCancelled('image_a')).toBe(true);
    });

    it('drops the uploaded bytes once an image is ready', () => {
        const ready = completeImageAttachment(
            [attachment({ thumbnail: { id: 'image_t', base64: 'REVG' } })],
            'image_a',
            1_000,
        );
        expect(ready).toEqual([
            {
                id: 'image_a',
                uri: 'file:///a.jpg',
                progress: 1,
                state: 'ready',
                uploadedAt: 1_000,
                thumbnail: { id: 'image_t' },
            },
        ]);
    });

    it('fails a ready image the Server has likely deleted, so Send waits instead of referencing it', () => {
        const ready = completeImageAttachment([attachment()], 'image_a', 0);
        expect(expireImageAttachments(ready, IMAGE_ATTACHMENT_REUSE_MS)).toBe(ready);
        const expired = expireImageAttachments(ready, IMAGE_ATTACHMENT_REUSE_MS + 1);
        expect(expired[0]).toMatchObject({ state: 'failed' });
        expect(imageAttachmentWaitReason(expired)).not.toBeNull();
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

describe("a Chat message's combined image size", () => {
    const MB = 1_024 * 1_024;
    const max = Math.ceil((20 * MB) / 3) * 4;

    it("keeps an image's size after its bytes are dropped on upload", () => {
        const [ready] = completeImageAttachment([attachment({ base64Length: 400 })], 'image_a', 1);
        expect(ready.base64).toBeUndefined();
        expect(ready.base64Length).toBe(400);
    });

    it('adds up the strip, leaving out the image being judged', () => {
        const strip = [
            attachment({ id: 'a', base64Length: 100 }),
            attachment({ id: 'b', base64Length: 50 }),
            attachment({ id: 'c', state: 'preparing' }),
        ];
        expect(imageAttachmentsBase64Length(strip)).toBe(150);
        expect(imageAttachmentsBase64Length(strip, 'a')).toBe(50);
    });

    it('notes the size only once the images use most of the limit', () => {
        expect(
            imageAttachmentBudgetNote([attachment({ base64Length: max / 2 })], max, 20 * MB),
        ).toBe(null);
        expect(
            imageAttachmentBudgetNote([attachment({ base64Length: max * 0.81 })], max, 20 * MB),
        ).toBe('Images use 16.2 of 20 MB.');
        expect(imageAttachmentBudgetNote([attachment({ base64Length: max })], max, 20 * MB)).toBe(
            'Images use 20 of 20 MB.',
        );
    });
});

describe('returning the images of a failed send', () => {
    it('puts them back ahead of images attached since, without duplicates', () => {
        const sent = [attachment({ id: 'sent' }), attachment({ id: 'kept' })];
        const current = [attachment({ id: 'later' }), attachment({ id: 'kept' })];
        expect(attachmentsWithReturned(current, sent).map(({ id }) => id)).toEqual([
            'sent',
            'later',
            'kept',
        ]);
        expect(attachmentsWithReturned(current, [attachment({ id: 'kept' })])).toBe(current);
    });
});
