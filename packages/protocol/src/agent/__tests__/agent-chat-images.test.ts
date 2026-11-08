import { describe, expect, it } from 'vitest';

import {
    agentChatImageToken,
    agentChatImageTokenRanges,
    agentChatTextWithOffsetImages,
    agentChatTextWithRenumberedImages,
    agentChatTextWithSentImageNumbers,
    draftWithoutImagePlaceholders,
} from '../agent-chat-images';

const image = (token?: number) => ({ token });

describe('agent chat image tokens', () => {
    it('writes the placeholder both terminal Agents use', () => {
        expect(agentChatImageToken(2)).toBe('[Image #2]');
    });

    it('reports where each placeholder sits', () => {
        expect(agentChatImageTokenRanges('a [Image #3]b')).toEqual([
            { number: 3, from: 2, to: 12 },
        ]);
    });

    it('renumbers placeholders and keeps the ones it has no number for', () => {
        const numbers = new Map([
            [4, 1],
            [7, 2],
        ]);
        expect(
            agentChatTextWithRenumberedImages(
                '[Image #7] then [Image #4] and [Image #9]',
                (number) => numbers.get(number),
            ),
        ).toBe('[Image #2] then [Image #1] and [Image #9]');
    });

    it('moves a joined message past the images before it', () => {
        expect(agentChatTextWithOffsetImages('see [Image #1] and [Image #3]', 2, 2)).toBe(
            'see [Image #3] and [Image #3]',
        );
        expect(agentChatTextWithOffsetImages('see [Image #1]', 0, 1)).toBe('see [Image #1]');
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
                image(2),
                image(),
                image(4),
            ]),
        ).toBe('[Image #3] before [Image #1], not [Image #9]');
    });

    it('leaves text alone when no image has a placeholder', () => {
        expect(agentChatTextWithSentImageNumbers('[Image #1]', [image()])).toBe('[Image #1]');
    });
});
