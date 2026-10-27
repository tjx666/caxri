import { describe, expect, it } from 'vitest';

import { agentChatImageStepForKey, stepAgentChatImageIndex } from '../agent-chat-image-gallery';

describe('stepAgentChatImageIndex', () => {
    it('moves one image either way', () => {
        expect(stepAgentChatImageIndex(1, 4, 'previous')).toBe(0);
        expect(stepAgentChatImageIndex(1, 4, 'next')).toBe(2);
    });

    it('stops at the first and last image instead of wrapping', () => {
        expect(stepAgentChatImageIndex(0, 4, 'previous')).toBe(0);
        expect(stepAgentChatImageIndex(3, 4, 'next')).toBe(3);
        expect(stepAgentChatImageIndex(0, 1, 'next')).toBe(0);
    });
});

describe('agentChatImageStepForKey', () => {
    it('maps Left and Right to the previous and next image', () => {
        expect(agentChatImageStepForKey('ArrowLeft', { canScrollSideways: false })).toBe(
            'previous',
        );
        expect(agentChatImageStepForKey('ArrowRight', { canScrollSideways: false })).toBe('next');
        expect(agentChatImageStepForKey('ArrowUp', { canScrollSideways: false })).toBeUndefined();
    });

    it('leaves the arrow keys to a zoomed-in picture that can pan sideways', () => {
        expect(agentChatImageStepForKey('ArrowLeft', { canScrollSideways: true })).toBeUndefined();
        expect(agentChatImageStepForKey('ArrowRight', { canScrollSideways: true })).toBeUndefined();
    });
});
