import { describe, expect, it } from 'vitest';

import {
    sessionListMotionScope,
    sessionListRowOrder,
    shouldAnimateSessionListChange,
} from '../session-list-motion';

const order = (...ids: string[]): string => sessionListRowOrder(ids.map((id) => ({ id })));

const change = (previousOrder: string, nextOrder: string, overrides = {}) =>
    shouldAnimateSessionListChange({
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

    it('shows the first rows of the list at once', () => {
        expect(change('', order('a', 'b'))).toBe(false);
    });

    it('never animates under reduced motion', () => {
        expect(change(order('a'), order('a', 'b'), { isReducedMotion: true })).toBe(false);
    });

    it('starts a new scope when a Project is chosen and again when its first read answers', () => {
        const allRead = sessionListMotionScope({ activeProjectId: null, readProjectId: null });
        const projectPending = sessionListMotionScope({
            activeProjectId: 'p1',
            readProjectId: null,
        });
        const projectRead = sessionListMotionScope({ activeProjectId: 'p1', readProjectId: 'p1' });
        const backToAllPending = sessionListMotionScope({
            activeProjectId: null,
            readProjectId: 'p1',
        });
        expect(new Set([allRead, projectPending, projectRead, backToAllPending]).size).toBe(4);
        expect(sessionListMotionScope({ activeProjectId: 'p1', readProjectId: 'p1' })).toBe(
            projectRead,
        );
    });
});
