import { describe, expect, it } from 'vitest';

import type { AgentChatAttachment, AgentChatImageAttachment } from '../agent-chat-drafts';
import {
    agentChatImagePlaceholderChanges,
    agentChatImagePlaceholderRemoval,
    agentChatTextWithSentImageNumbers,
    attachmentsWithReattached,
    draftWithoutImagePlaceholders,
    nextAgentChatImageToken,
} from '../agent-chat-image-placeholders';

function image(id: string, token?: number): AgentChatImageAttachment {
    return {
        id,
        image: { mediaType: 'image/png', data: 'AAAA', thumbnail: 'data:image/jpeg;base64,AAAA' },
        ...(token !== undefined && { token }),
    };
}

const card: AgentChatAttachment = { id: 'card', path: '/work/notes.md', isDirectory: false };

describe('nextAgentChatImageToken', () => {
    it('starts at 1 for an empty draft', () => {
        expect(nextAgentChatImageToken('', [], [])).toBe(1);
    });

    it('goes past every number the draft, its images, and removed images use', () => {
        expect(nextAgentChatImageToken('see [Image #4]', [image('a', 2), card], [])).toBe(5);
        expect(nextAgentChatImageToken('', [image('a', 2)], [7])).toBe(8);
    });
});

describe('agentChatImagePlaceholderChanges', () => {
    it('detaches an image whose placeholder left the draft', () => {
        const first = image('a', 1);
        const second = image('b', 2);
        expect(
            agentChatImagePlaceholderChanges('only [Image #2]', [first, second, card], new Map()),
        ).toEqual({ detached: [first], reattached: [] });
    });

    it('never detaches an image without a placeholder', () => {
        expect(agentChatImagePlaceholderChanges('text', [image('a')], new Map())).toEqual({
            detached: [],
            reattached: [],
        });
    });

    it('reattaches a removed image whose placeholder came back', () => {
        const removed = image('a', 1);
        const taken = new Map([
            [1, removed],
            [3, image('c', 3)],
        ]);
        expect(agentChatImagePlaceholderChanges('[Image #1] back', [], taken)).toEqual({
            detached: [],
            reattached: [removed],
        });
    });
});

describe('attachmentsWithReattached', () => {
    it('puts a returned image back in token order among the images', () => {
        const next = attachmentsWithReattached(
            [card, image('a', 1), image('c', 3)],
            [image('b', 2)],
        );
        expect(next.map(({ id }) => id)).toEqual(['card', 'a', 'b', 'c']);
        expect(
            attachmentsWithReattached([image('a', 1)], [image('z', 9)]).map(({ id }) => id),
        ).toEqual(['a', 'z']);
    });
});

describe('draftWithoutImagePlaceholders', () => {
    it('removes a placeholder with one space beside it', () => {
        expect(draftWithoutImagePlaceholders('look at [Image #1] closely', new Set([1]))).toBe(
            'look at closely',
        );
        expect(draftWithoutImagePlaceholders('look at [Image #1]', new Set([1]))).toBe('look at');
        expect(draftWithoutImagePlaceholders('[Image #1] [Image #2] why', new Set([1, 2]))).toBe(
            'why',
        );
    });

    it('keeps the placeholders of other images', () => {
        expect(draftWithoutImagePlaceholders('[Image #1] and [Image #2]', new Set([2]))).toBe(
            '[Image #1] and',
        );
    });
});

describe('agentChatTextWithSentImageNumbers', () => {
    it('numbers placeholders by the order the images are sent', () => {
        expect(
            agentChatTextWithSentImageNumbers('[Image #4] before [Image #2], not [Image #9]', [
                image('a', 2),
                image('b'),
                image('c', 4),
            ]),
        ).toBe('[Image #3] before [Image #1], not [Image #9]');
    });

    it('leaves text alone when no image has a placeholder', () => {
        expect(agentChatTextWithSentImageNumbers('[Image #1]', [image('a')])).toBe('[Image #1]');
    });
});

describe('agentChatImagePlaceholderRemoval', () => {
    it('takes the placeholder out as one edit and keeps the caret beside its text', () => {
        const draft = 'see [Image #1] and type';
        expect(agentChatImagePlaceholderRemoval(draft, draft.length, new Set([1]))).toEqual({
            from: 4,
            to: 15,
            text: '',
            caret: draft.length - 11,
        });
        expect(agentChatImagePlaceholderRemoval(draft, 2, new Set([1]))?.caret).toBe(2);
        expect(agentChatImagePlaceholderRemoval(draft, 8, new Set([1]))?.caret).toBe(4);
    });

    it('is undefined when the draft has no such placeholder', () => {
        expect(agentChatImagePlaceholderRemoval('text', 0, new Set([1]))).toBeUndefined();
    });
});
