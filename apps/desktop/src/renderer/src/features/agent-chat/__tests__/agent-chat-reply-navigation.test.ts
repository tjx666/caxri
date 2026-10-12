import { describe, expect, it } from 'vitest';

import {
    agentChatAdjacentReplyIndex,
    agentChatReplyNavigationDirection,
} from '../agent-chat-reply-navigation';

const chord = (
    key: string,
    modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {},
) => ({
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key,
    ...modifiers,
});

describe('agentChatReplyNavigationDirection', () => {
    it('steps only on Option with an arrow, leaving plain arrows to scroll', () => {
        expect(agentChatReplyNavigationDirection(chord('ArrowUp', { altKey: true }))).toBe(
            'previous',
        );
        expect(agentChatReplyNavigationDirection(chord('ArrowDown', { altKey: true }))).toBe(
            'next',
        );
        expect(agentChatReplyNavigationDirection(chord('ArrowUp'))).toBeUndefined();
        expect(
            agentChatReplyNavigationDirection(chord('ArrowUp', { altKey: true, shiftKey: true })),
        ).toBeUndefined();
        expect(agentChatReplyNavigationDirection(chord('c', { altKey: true }))).toBeUndefined();
    });
});

describe('agentChatAdjacentReplyIndex', () => {
    it('starts at the latest reply from the transcript itself', () => {
        const relations = ['inside', 'inside', 'inside'] as const;
        expect(agentChatAdjacentReplyIndex(relations, 'previous')).toBe(2);
        expect(agentChatAdjacentReplyIndex(relations, 'next')).toBe(2);
        expect(agentChatAdjacentReplyIndex([], 'previous')).toBeUndefined();
    });

    it('steps to the neighbor of the focused reply and stops at either end', () => {
        expect(agentChatAdjacentReplyIndex(['before', 'contains', 'after'], 'previous')).toBe(0);
        expect(agentChatAdjacentReplyIndex(['before', 'contains', 'after'], 'next')).toBe(2);
        expect(agentChatAdjacentReplyIndex(['contains', 'after'], 'previous')).toBeUndefined();
        expect(agentChatAdjacentReplyIndex(['before', 'contains'], 'next')).toBeUndefined();
    });

    it('takes the nearest reply that way from a row between replies', () => {
        const relations = ['before', 'before', 'after', 'after'] as const;
        expect(agentChatAdjacentReplyIndex(relations, 'previous')).toBe(1);
        expect(agentChatAdjacentReplyIndex(relations, 'next')).toBe(2);
        expect(agentChatAdjacentReplyIndex(['after'], 'previous')).toBeUndefined();
    });
});
