import { describe, expect, it } from 'vitest';

import { sessionListRowOrder, shouldAnimateSessionListChange } from '../session-list-motion';

const order = (...ids: string[]): string => sessionListRowOrder(ids.map((id) => ({ id })));

const change = (previousOrder: string, nextOrder: string, overrides = {}) =>
    shouldAnimateSessionListChange({
        isActive: true,
        isReducedMotion: false,
        nextOrder,
        previousOrder,
        ...overrides,
    });

describe('Session list motion', () => {
    it('animates a Session appearing, leaving, or moving to another group', () => {
        expect(change(order('a', 'b'), order('new', 'a', 'b'))).toBe(true);
        expect(change(order('a', 'b'), order('a'))).toBe(true);
        expect(
            change(order('h-waiting', 'a', 'h-idle', 'b'), order('h-waiting', 'a', 'b', 'h-idle')),
        ).toBe(true);
    });

    it('applies a refresh that keeps the same rows in place without motion', () => {
        expect(change(order('a', 'b'), order('a', 'b'))).toBe(false);
    });

    it('shows the first rows of a page at once', () => {
        expect(change('', order('a', 'b'))).toBe(false);
    });

    it('never animates an off-screen page or under reduced motion', () => {
        expect(change(order('a'), order('a', 'b'), { isActive: false })).toBe(false);
        expect(change(order('a'), order('a', 'b'), { isReducedMotion: true })).toBe(false);
    });
});
