import { describe, expect, it } from 'vitest';

import {
    agentChatImageToken,
    agentChatImageTokenRanges,
    agentChatTextWithOffsetImages,
    agentChatTextWithRenumberedImages,
} from '../agent-chat-image-tokens';

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
