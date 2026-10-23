import { describe, expect, it } from 'vitest';

import { clip, tail } from '../agent-chat/chat-items';
import { ownedSlice } from '../owned-string';

describe('ownedSlice', () => {
    it('copies the requested range, lone surrogates included', () => {
        const text = `ab\u{D83D}cd`;
        expect(ownedSlice(text, 1, 3)).toBe('b\u{D83D}');
        expect(ownedSlice(text, 3)).toBe('cd');
    });

    it('backs clip and tail only when they truncate', () => {
        expect(clip('abcdef', 3)).toBe('abc');
        expect(tail('abcdef', 3)).toBe('def');
        expect(clip('abc', 3)).toBe('abc');
    });
});
