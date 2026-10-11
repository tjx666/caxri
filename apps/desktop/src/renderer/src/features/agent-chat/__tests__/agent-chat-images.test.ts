import {
    MAX_AGENT_CHAT_IMAGE_BYTES,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { attachmentsAfterSend } from '../agent-chat-drafts';
import {
    agentChatImageBytes,
    agentChatImageRejection,
    agentChatImageRejectionMessage,
    agentChatImagesUnsupportedMessage,
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
                { type: 'image/jpeg', size: MAX_AGENT_CHAT_IMAGE_BYTES + 1 },
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
});
