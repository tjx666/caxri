import { MAX_AGENT_CHAT_IMAGE_BYTES, MAX_AGENT_CHAT_IMAGES } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { attachmentsAfterSend } from '../agent-chat-drafts';
import {
    agentChatImageRejection,
    agentChatImageRejectionMessage,
    agentChatImagesUnsupportedMessage,
    agentChatThumbnailSize,
} from '../agent-chat-images';

describe('Agent Chat image attachments', () => {
    it('accepts provider image types within the size and count limits', () => {
        expect(agentChatImageRejection({ type: 'image/png', size: 1024 }, 0)).toBeUndefined();
        expect(agentChatImageRejection({ type: 'image/svg+xml', size: 10 }, 0)).toBe('type');
        expect(agentChatImageRejection({ type: 'application/pdf', size: 10 }, 0)).toBe('type');
        expect(
            agentChatImageRejection(
                { type: 'image/jpeg', size: MAX_AGENT_CHAT_IMAGE_BYTES + 1 },
                0,
            ),
        ).toBe('size');
        expect(
            agentChatImageRejection({ type: 'image/webp', size: 10 }, MAX_AGENT_CHAT_IMAGES),
        ).toBe('count');
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
        expect(agentChatImagesUnsupportedMessage('Grok Build')).toBe(
            'Grok Build Chat does not accept images',
        );
    });
});
