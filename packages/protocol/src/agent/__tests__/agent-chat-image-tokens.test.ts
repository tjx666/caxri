import { describe, expect, it } from 'vitest';

import {
    agentChatImageToken,
    agentChatImageTokenRanges,
    agentChatTextSegments,
    agentChatTextWithOffsetImages,
    agentChatTextWithRenumberedImages,
} from '../agent-chat-image-tokens';

describe('agent chat image tokens', () => {
    it('writes the placeholder both terminal Agents use', () => {
        expect(agentChatImageToken(2)).toBe('[Image #2]');
    });

    it('cuts text at its placeholders in order', () => {
        expect(agentChatTextSegments('Compare [Image #1] with [Image #2]')).toEqual([
            { kind: 'text', text: 'Compare ' },
            { kind: 'image', number: 1, text: '[Image #1]' },
            { kind: 'text', text: ' with ' },
            { kind: 'image', number: 2, text: '[Image #2]' },
        ]);
        expect(agentChatTextSegments('no images')).toEqual([{ kind: 'text', text: 'no images' }]);
        expect(agentChatTextSegments('')).toEqual([]);
    });

    it('ignores text that only looks like a placeholder', () => {
        expect(agentChatTextSegments('[Image #0] [image #1] [Image #]')).toEqual([
            { kind: 'text', text: '[Image #0] [image #1] [Image #]' },
        ]);
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
