import { MAX_AGENT_CHAT_IMAGE_BYTES, MAX_AGENT_CHAT_IMAGES } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { attachmentsAfterSend } from '../agent-chat-drafts';
import { agentChatImageRejection, agentChatThumbnailSize } from '../agent-chat-images';

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

    it('fits thumbnails inside the edge while keeping the aspect ratio', () => {
        expect(agentChatThumbnailSize(1600, 800)).toEqual({ width: 160, height: 80 });
        expect(agentChatThumbnailSize(300, 3000)).toEqual({ width: 16, height: 160 });
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
});
