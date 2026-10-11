import {
    MAX_AGENT_CHAT_IMAGE_BYTES,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatAttachmentLabel, attachmentsAfterSend } from '../agent-chat-drafts';
import {
    agentChatDroppedImagePlan,
    agentChatImageBytes,
    agentChatImageRejection,
    agentChatImageRejectionMessage,
    agentChatImageReservedBytes,
    agentChatImageResizeAttempts,
    agentChatImagesUnsupportedMessage,
    agentChatInsertedImagePathMessage,
    agentChatThumbnailSize,
} from '../agent-chat-images';

describe('Agent Chat image attachments', () => {
    it('accepts provider image types within the size, count, and combined size limits', () => {
        const empty = { count: 0, bytes: 0 };
        expect(agentChatImageRejection({ type: 'image/png', size: 1024 }, empty)).toBeUndefined();
        expect(agentChatImageRejection({ type: 'image/svg+xml', size: 10 }, empty)).toBe('type');
        expect(agentChatImageRejection({ type: 'application/pdf', size: 10 }, empty)).toBe('type');
        expect(
            agentChatImageRejection(
                { type: 'image/gif', size: MAX_AGENT_CHAT_IMAGE_BYTES + 1 },
                empty,
            ),
        ).toBe('size');
        // More than four images now fit, up to the count limit.
        expect(
            agentChatImageRejection({ type: 'image/webp', size: 10 }, { count: 4, bytes: 40 }),
        ).toBeUndefined();
        expect(
            agentChatImageRejection(
                { type: 'image/webp', size: 10 },
                { count: MAX_AGENT_CHAT_IMAGES, bytes: 10 },
            ),
        ).toBe('count');
        // Images that each fit may still add up past the combined limit.
        expect(
            agentChatImageRejection(
                { type: 'image/png', size: MAX_AGENT_CHAT_IMAGE_BYTES },
                {
                    count: 4,
                    bytes: MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES - MAX_AGENT_CHAT_IMAGE_BYTES + 1,
                },
            ),
        ).toBe('total');
        expect(
            agentChatImageRejection(
                { type: 'image/png', size: MAX_AGENT_CHAT_IMAGE_BYTES },
                { count: 3, bytes: MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES - MAX_AGENT_CHAT_IMAGE_BYTES },
            ),
        ).toBeUndefined();
    });

    it('counts an attached image by its decoded bytes', () => {
        expect(agentChatImageBytes({ data: btoa('abc') })).toBe(3);
        expect(agentChatImageBytes({ data: btoa('abcd') })).toBe(4);
        expect(agentChatImageBytes({ data: btoa('abcde') })).toBe(5);
    });

    it.each(['image/png', 'image/jpeg', 'image/webp'])(
        'accepts an oversized %s so it can be resized instead of refused',
        (type) => {
            expect(
                agentChatImageRejection(
                    { type, size: MAX_AGENT_CHAT_IMAGE_BYTES * 3 },
                    { count: 0, bytes: 0 },
                ),
            ).toBeUndefined();
        },
    );

    it('reserves an oversized image at the per-image limit it will be resized to', () => {
        expect(agentChatImageReservedBytes({ size: MAX_AGENT_CHAT_IMAGE_BYTES * 3 })).toBe(
            MAX_AGENT_CHAT_IMAGE_BYTES,
        );
        expect(agentChatImageReservedBytes({ size: 1024 })).toBe(1024);
        // A 15 MB screenshot still fits beside images that leave room for one resized image.
        expect(
            agentChatImageRejection(
                { type: 'image/png', size: MAX_AGENT_CHAT_IMAGE_BYTES * 3 },
                { count: 2, bytes: MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES - MAX_AGENT_CHAT_IMAGE_BYTES },
            ),
        ).toBeUndefined();
    });

    it('resizes an 8 MB PNG screenshot losslessly, starting near the limit and shrinking further', () => {
        const attempts = agentChatImageResizeAttempts(5120, 2880, 8 * 1024 * 1024, 'image/png');
        // sqrt(5 MB * 0.85 / 8 MB) is about 0.729 of each edge.
        expect(attempts[0]).toEqual({ width: 3732, height: 2099 });
        expect(attempts.every((attempt) => attempt.quality === undefined)).toBe(true);
        expect(attempts.at(1)).toEqual({ width: 2985, height: 1679 });
        expect(attempts).toHaveLength(6);
    });

    it('steps a photo down in both size and quality, keeping its aspect ratio', () => {
        const attempts = agentChatImageResizeAttempts(4000, 3000, 20 * 1024 * 1024, 'image/jpeg');
        expect(attempts.map((attempt) => attempt.quality)).toEqual([
            0.9, 0.85, 0.8, 0.75, 0.7, 0.65,
        ]);
        for (const attempt of attempts)
            expect(attempt.width / attempt.height).toBeCloseTo(4 / 3, 2);
    });

    it('stops before an image would become too small to be worth sending', () => {
        expect(agentChatImageResizeAttempts(600, 400, 200 * 1024 * 1024, 'image/png')).toEqual([]);
        expect(
            agentChatImageResizeAttempts(1000, 1000, 8 * 1024 * 1024, 'image/png').map(
                (attempt) => attempt.width,
            ),
        ).toEqual([729, 583, 466, 373]);
    });

    it('notes a resized image in its alt text', () => {
        expect(agentChatAttachmentLabel({ name: 'shot.png', isResized: true }, 0)).toBe(
            'shot.png (resized to fit the 5 mb limit)',
        );
        expect(agentChatAttachmentLabel({ name: '' }, 1)).toBe('Attachment 2');
    });

    it('sizes thumbnails to cover their previews at 2x while keeping the aspect ratio', () => {
        // A screenshot keeps the 192 device pixels of height its 96 CSS pixel preview shows at 2x.
        expect(agentChatThumbnailSize(1600, 800)).toEqual({ width: 384, height: 192 });
        // A tall image keeps the 128 pixel width the square composer chip crops to.
        expect(agentChatThumbnailSize(600, 1200)).toEqual({ width: 128, height: 256 });
        // An extreme aspect ratio stops at the long-edge cap, and a small image is never upscaled.
        expect(agentChatThumbnailSize(8000, 500)).toEqual({ width: 768, height: 48 });
        expect(agentChatThumbnailSize(300, 3000)).toEqual({ width: 77, height: 768 });
        expect(agentChatThumbnailSize(40, 20)).toEqual({ width: 40, height: 20 });
    });

    it('clears only the attachments that were sent', () => {
        const image = { mediaType: 'image/png' as const, data: 'AA==', thumbnail: 'data:,' };
        const sent = [{ id: 'a', image }];
        const current = [...sent, { id: 'b', image }];
        expect(attachmentsAfterSend(current, sent).map((attachment) => attachment.id)).toEqual([
            'b',
        ]);
    });

    it('names the oversized files in the size rejection', () => {
        expect(agentChatImageRejectionMessage('size', ['huge.png', 'big.jpg'])).toBe(
            `Images must be ${MAX_AGENT_CHAT_IMAGE_BYTES / 1024 / 1024} MB or smaller: huge.png, big.jpg`,
        );
        expect(agentChatImageRejectionMessage('size')).toBe(
            `Images must be ${MAX_AGENT_CHAT_IMAGE_BYTES / 1024 / 1024} MB or smaller`,
        );
        expect(agentChatImageRejectionMessage('total', ['third.png'])).toBe(
            `Images in one message must add up to ${MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES / 1024 / 1024} MB or less: third.png`,
        );
        expect(agentChatImagesUnsupportedMessage('Grok Build')).toBe(
            'Grok Build Chat does not accept images',
        );
    });

    it('cites a dropped image by path when its format or size cannot be attached, resizing what it can', () => {
        const png = { type: 'image/png', size: 10 };
        const svg = { type: 'image/svg+xml', size: 10 };
        const hugeJpeg = { type: 'image/jpeg', size: MAX_AGENT_CHAT_IMAGE_BYTES + 1 };
        const huge = { type: 'image/gif', size: MAX_AGENT_CHAT_IMAGE_BYTES + 1 };
        expect(agentChatDroppedImagePlan([png, svg, hugeJpeg, huge])).toEqual({
            attach: [png, hugeJpeg],
            inserted: [
                { file: svg, rejection: 'type' },
                { file: huge, rejection: 'size' },
            ],
        });
        expect(agentChatInsertedImagePathMessage([])).toBeUndefined();
        expect(agentChatInsertedImagePathMessage(['type'])).toBe(
            'Only PNG, JPEG, GIF, and WebP images can be attached. Inserted the path instead',
        );
        expect(agentChatInsertedImagePathMessage(['size', 'size'])).toBe(
            `GIFs over ${MAX_AGENT_CHAT_IMAGE_BYTES / 1024 / 1024} MB cannot be attached. Inserted the paths instead`,
        );
    });
});
