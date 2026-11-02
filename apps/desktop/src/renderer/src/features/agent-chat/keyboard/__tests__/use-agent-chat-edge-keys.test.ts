import { describe, expect, it } from 'vitest';

import { agentChatScrollEdge, isAgentChatEdgeKeyTarget } from '../use-agent-chat-edge-keys';

const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe('agentChatScrollEdge', () => {
    it('maps Home and Cmd+ArrowUp to the top, End and Cmd+ArrowDown to the bottom', () => {
        expect(agentChatScrollEdge({ ...plain, key: 'Home' })).toBe('top');
        expect(agentChatScrollEdge({ ...plain, key: 'ArrowUp', metaKey: true })).toBe('top');
        expect(agentChatScrollEdge({ ...plain, key: 'End' })).toBe('bottom');
        expect(agentChatScrollEdge({ ...plain, key: 'ArrowDown', metaKey: true })).toBe('bottom');
    });

    it('leaves plain arrows, Cmd+Home, and chords with other modifiers alone', () => {
        expect(agentChatScrollEdge({ ...plain, key: 'ArrowUp' })).toBeUndefined();
        expect(agentChatScrollEdge({ ...plain, key: 'Home', metaKey: true })).toBeUndefined();
        expect(agentChatScrollEdge({ ...plain, key: 'End', shiftKey: true })).toBeUndefined();
        expect(
            agentChatScrollEdge({ ...plain, key: 'ArrowUp', metaKey: true, shiftKey: true }),
        ).toBeUndefined();
        expect(agentChatScrollEdge({ ...plain, key: 'ArrowDown', altKey: true })).toBeUndefined();
        expect(agentChatScrollEdge({ ...plain, key: 'Home', ctrlKey: true })).toBeUndefined();
    });
});

describe('isAgentChatEdgeKeyTarget', () => {
    const outside = {
        isComposerTarget: false,
        composerDraft: '',
        isTranscriptTarget: false,
        isEditableTarget: false,
    };

    it('takes the keys from an empty composer and keeps them for a draft', () => {
        const composer = { ...outside, isComposerTarget: true, isEditableTarget: true };
        expect(isAgentChatEdgeKeyTarget(composer)).toBe(true);
        expect(isAgentChatEdgeKeyTarget({ ...composer, composerDraft: ' \n' })).toBe(true);
        expect(isAgentChatEdgeKeyTarget({ ...composer, composerDraft: 'fix the' })).toBe(false);
    });

    it('takes the keys from the transcript but not from a field inside it or elsewhere in the pane', () => {
        expect(isAgentChatEdgeKeyTarget({ ...outside, isTranscriptTarget: true })).toBe(true);
        expect(
            isAgentChatEdgeKeyTarget({
                ...outside,
                isTranscriptTarget: true,
                isEditableTarget: true,
            }),
        ).toBe(false);
        expect(isAgentChatEdgeKeyTarget(outside)).toBe(false);
    });
});
