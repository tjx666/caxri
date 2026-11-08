import { describe, expect, it } from 'vitest';

import {
    agentChatImagePlaceholderSync,
    draftWithImagePlaceholders,
    draftWithWholePlaceholders,
} from '../agent-chat-image-placeholders';

describe('agentChatImagePlaceholderSync', () => {
    it('numbers a newly attached image and asks for its placeholder', () => {
        const sync = agentChatImagePlaceholderSync({
            draft: 'look at [Image #1] ',
            imageIds: ['a', 'b'],
            tokens: new Map([['a', 1]]),
        });
        expect(sync.inserted).toEqual([2]);
        expect([...sync.tokens]).toEqual([
            ['a', 1],
            ['b', 2],
        ]);
        expect(sync.detached).toEqual([]);
        expect(sync.orphaned).toEqual([]);
    });

    it('detaches an image whose placeholder was deleted from the draft', () => {
        const sync = agentChatImagePlaceholderSync({
            draft: 'only [Image #2] ',
            imageIds: ['a', 'b'],
            tokens: new Map([
                ['a', 1],
                ['b', 2],
            ]),
        });
        expect(sync.detached).toEqual(['a']);
        expect([...sync.tokens]).toEqual([['b', 2]]);
    });

    it('drops the placeholder of an image taken out of the strip', () => {
        const sync = agentChatImagePlaceholderSync({
            draft: '[Image #1] [Image #2] why',
            imageIds: ['b'],
            tokens: new Map([
                ['a', 1],
                ['b', 2],
            ]),
        });
        expect(sync.orphaned).toEqual([1]);
        expect(sync.inserted).toEqual([]);
    });

    it('gives images returned with an unsent message their placeholders back in order', () => {
        const sync = agentChatImagePlaceholderSync({
            draft: '[Image #2] after [Image #1]',
            imageIds: ['a', 'b'],
            tokens: new Map(),
        });
        expect(sync.inserted).toEqual([]);
        expect([...sync.tokens]).toEqual([
            ['a', 2],
            ['b', 1],
        ]);
    });

    it('starts numbering over once the draft and its images are empty', () => {
        const sync = agentChatImagePlaceholderSync({
            draft: '',
            imageIds: ['c'],
            tokens: new Map(),
        });
        expect(sync.inserted).toEqual([1]);
    });
});

describe('draftWithWholePlaceholders', () => {
    const owned = new Set([1]);

    it('takes a placeholder out whole when Backspace cuts into it', () => {
        expect(draftWithWholePlaceholders('see [Image #1] ok', 'see [Image #1 ok', owned)).toBe(
            'see  ok',
        );
    });

    it('leaves typing, ordinary deletions, and unowned placeholders alone', () => {
        expect(draftWithWholePlaceholders('see [Image #1]', 'see [Image #1]!', owned)).toBe(
            'see [Image #1]!',
        );
        expect(draftWithWholePlaceholders('see [Image #1] ok', 'se [Image #1] ok', owned)).toBe(
            'se [Image #1] ok',
        );
        expect(draftWithWholePlaceholders('see [Image #2] ok', 'see [Image #2 ok', owned)).toBe(
            'see [Image #2 ok',
        );
    });
});

describe('draftWithImagePlaceholders', () => {
    it('writes the placeholders at the cursor with a space around them', () => {
        expect(draftWithImagePlaceholders('see this', 3, [1, 2])).toEqual({
            cursor: 26,
            draft: 'see [Image #1] [Image #2] this',
        });
        expect(draftWithImagePlaceholders('', 0, [1])).toEqual({
            cursor: 11,
            draft: '[Image #1] ',
        });
    });
});
