import { describe, expect, it } from 'vitest';

import {
    agentChatImageStepForKey,
    isAgentChatImageCopyKey,
    stepAgentChatImageIndex,
} from '../agent-chat-image-gallery';

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

describe('isAgentChatImageCopyKey', () => {
    const copy = { altKey: false, ctrlKey: false, key: 'c', metaKey: true, shiftKey: false };

    it('takes Cmd+C or Ctrl+C with no text selected', () => {
        expect(isAgentChatImageCopyKey(copy, { hasSelection: false })).toBe(true);
        expect(
            isAgentChatImageCopyKey(
                { ...copy, ctrlKey: true, metaKey: false },
                { hasSelection: false },
            ),
        ).toBe(true);
    });

    it('leaves Copy to the browser over a text selection or with other modifiers', () => {
        expect(isAgentChatImageCopyKey(copy, { hasSelection: true })).toBe(false);
        expect(isAgentChatImageCopyKey({ ...copy, shiftKey: true }, { hasSelection: false })).toBe(
            false,
        );
        expect(isAgentChatImageCopyKey({ ...copy, key: 'v' }, { hasSelection: false })).toBe(false);
    });
});
