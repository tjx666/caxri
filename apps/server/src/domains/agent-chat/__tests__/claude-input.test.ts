import { describe, expect, it } from 'vitest';

import { claudeUserPrompt } from '../claude-input';

const image = {
    mediaType: 'image/png' as const,
    data: 'iVBORw0KGgo=',
    thumbnail: 'data:image/jpeg;base64,/9j/',
};

describe('claudeUserPrompt', () => {
    it('sends the text ahead of its images, as the Claude Code TUI does', () => {
        const { message } = claudeUserPrompt({
            uuid: crypto.randomUUID(),
            turnId: 'turn-1',
            sessionId: 'session-1',
            text: 'compare [Image #1] with [Image #2]',
            images: [image, image],
        });
        expect(message.message.content).toEqual([
            { type: 'text', text: 'compare [Image #1] with [Image #2]' },
            {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: image.data },
            },
            {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: image.data },
            },
        ]);
    });

    it('sends an image-only message without an empty text block', () => {
        const { message } = claudeUserPrompt({
            uuid: crypto.randomUUID(),
            turnId: 'turn-1',
            sessionId: 'session-1',
            text: '',
            images: [image],
        });
        expect(message.message.content).toHaveLength(1);
    });
});
