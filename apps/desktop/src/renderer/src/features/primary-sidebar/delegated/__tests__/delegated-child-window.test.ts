import { describe, expect, it } from 'vitest';

import { DELEGATED_IDLE_VISIBLE_COUNT, delegatedChildWindow } from '../delegated-child-window';

function children(count: number): Array<{ id: string }> {
    return Array.from({ length: count }, (_, index) => ({ id: `c${index + 1}` }));
}

function ids(sessions: ReadonlyArray<{ id: string }>): string[] {
    return sessions.map(({ id }) => id);
}

const noneActive = new Set<string>();

describe('delegatedChildWindow', () => {
    it('shows three idle children before a reveal row appears', () => {
        expect(DELEGATED_IDLE_VISIBLE_COUNT).toBe(3);
        const window = delegatedChildWindow(children(3), {
            activeSessionIds: noneActive,
            revealedCount: undefined,
            selectedSessionId: undefined,
        });
        expect(ids(window.visibleSessions)).toEqual(['c1', 'c2', 'c3']);
        expect(window.hiddenCount).toBe(0);
    });

    it('folds the idle children past the first three behind a count', () => {
        const window = delegatedChildWindow(children(10), {
            activeSessionIds: noneActive,
            revealedCount: undefined,
            selectedSessionId: undefined,
        });
        expect(ids(window.visibleSessions)).toEqual(['c1', 'c2', 'c3']);
        expect(window.hiddenCount).toBe(7);
        expect(window.windowCount).toBe(3);
    });

    it('never folds an active child, and counts only the idle ones in the reveal', () => {
        const window = delegatedChildWindow(children(10), {
            activeSessionIds: new Set(['c8', 'c9']),
            revealedCount: undefined,
            selectedSessionId: undefined,
        });
        expect(ids(window.visibleSessions)).toEqual(['c1', 'c2', 'c3', 'c8', 'c9']);
        // 8 idle children, 3 shown.
        expect(window.hiddenCount).toBe(5);
    });

    it('does not let active children use up the idle allowance', () => {
        const window = delegatedChildWindow(children(6), {
            activeSessionIds: new Set(['c1', 'c2', 'c3']),
            revealedCount: undefined,
            selectedSessionId: undefined,
        });
        expect(ids(window.visibleSessions)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
        expect(window.hiddenCount).toBe(0);
    });

    it('keeps the sidebar order across active and idle children', () => {
        const window = delegatedChildWindow(children(8), {
            activeSessionIds: new Set(['c6']),
            revealedCount: undefined,
            selectedSessionId: undefined,
        });
        expect(ids(window.visibleSessions)).toEqual(['c1', 'c2', 'c3', 'c6']);
    });

    it('keeps the selected idle child on screen even beyond the window', () => {
        const window = delegatedChildWindow(children(10), {
            activeSessionIds: noneActive,
            revealedCount: undefined,
            selectedSessionId: 'c9',
        });
        expect(ids(window.visibleSessions)).toEqual(['c1', 'c2', 'c3', 'c9']);
        expect(window.hiddenCount).toBe(6);
    });

    it('reveals more idle children as the window count grows', () => {
        const first = delegatedChildWindow(children(20), {
            activeSessionIds: noneActive,
            revealedCount: undefined,
            selectedSessionId: undefined,
        });
        expect(first.nextRevealCount).toBeGreaterThan(first.windowCount);
        const second = delegatedChildWindow(children(20), {
            activeSessionIds: noneActive,
            revealedCount: first.nextRevealCount,
            selectedSessionId: undefined,
        });
        expect(second.visibleSessions.length).toBe(first.nextRevealCount);
        expect(second.hiddenCount).toBe(20 - first.nextRevealCount);
    });

    it('shows everything once the reveal reaches the idle count', () => {
        const window = delegatedChildWindow(children(8), {
            activeSessionIds: new Set(['c2']),
            revealedCount: 100,
            selectedSessionId: undefined,
        });
        expect(window.visibleSessions.length).toBe(8);
        expect(window.hiddenCount).toBe(0);
    });

    it('returns an empty window for a host with no children', () => {
        const window = delegatedChildWindow([], {
            activeSessionIds: noneActive,
            revealedCount: undefined,
            selectedSessionId: undefined,
        });
        expect(window.visibleSessions).toEqual([]);
        expect(window.hiddenCount).toBe(0);
    });
});
