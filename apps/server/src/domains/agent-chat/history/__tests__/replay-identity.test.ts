import { describe, expect, it } from 'vitest';

import { isSameChatHistory } from '../replay-identity';

describe('isSameChatHistory', () => {
    const previous = { historyId: 'history-1', itemIds: ['a', 'b', 'c'] };

    it('keeps the history when a replay brings back the same items, with older or newer ones around them', () => {
        expect(isSameChatHistory(previous, { itemIds: ['a', 'b', 'c'] })).toBe(true);
        expect(isSameChatHistory(previous, { itemIds: ['a', 'b', 'c', 'd'] })).toBe(true);
        expect(isSameChatHistory(previous, { itemIds: ['z', 'a', 'b', 'c'] })).toBe(true);
    });

    it('starts over when a replay drops, reorders, or renames items, or there was nothing to page', () => {
        expect(isSameChatHistory(previous, { itemIds: ['a', 'b'] })).toBe(false);
        expect(isSameChatHistory(previous, { itemIds: ['a', 'c', 'b'] })).toBe(false);
        expect(isSameChatHistory(previous, { itemIds: ['x', 'b', 'c'] })).toBe(false);
        expect(isSameChatHistory({ historyId: 'history-1', itemIds: [] }, { itemIds: ['a'] })).toBe(
            false,
        );
    });
});
