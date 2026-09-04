import { describe, expect, it } from 'vitest';

import {
    DEFAULT_VISIBLE_SESSION_COUNT,
    nextRevealedSessionCount,
    SESSION_REVEAL_STEP,
    sessionListWindow,
} from '../session-list-window';

function sessions(count: number): Array<{ id: string }> {
    return Array.from({ length: count }, (_, index) => ({ id: `session-${index + 1}` }));
}

describe('sessionListWindow', () => {
    it('shows every Session while the Project stays under the default window', () => {
        const window = sessionListWindow(sessions(5), undefined, undefined);
        expect(window.visibleSessions).toHaveLength(DEFAULT_VISIBLE_SESSION_COUNT);
        expect(window.hiddenCount).toBe(0);
        expect(window.nextRevealCount).toBe(0);
    });

    it('keeps only the most recent Sessions and reports the rest as hidden', () => {
        const window = sessionListWindow(sessions(12), undefined, undefined);
        expect(window.visibleSessions.map((session) => session.id)).toEqual([
            'session-1',
            'session-2',
            'session-3',
            'session-4',
            'session-5',
        ]);
        expect(window.hiddenCount).toBe(7);
    });

    it('promises a full step while more than one step is hidden', () => {
        expect(sessionListWindow(sessions(40), undefined, undefined).nextRevealCount).toBe(
            SESSION_REVEAL_STEP,
        );
    });

    it('promises only what is left on the final step', () => {
        expect(sessionListWindow(sessions(12), undefined, undefined).nextRevealCount).toBe(7);
    });

    it('widens the window to a revealed count', () => {
        const window = sessionListWindow(sessions(40), 15, undefined);
        expect(window.visibleSessions).toHaveLength(15);
        expect(window.hiddenCount).toBe(25);
    });

    it('never narrows below the default, even for a stale revealed count', () => {
        const window = sessionListWindow(sessions(12), 2, undefined);
        expect(window.visibleSessions).toHaveLength(DEFAULT_VISIBLE_SESSION_COUNT);
    });

    it('clamps a revealed count that outran the Session list', () => {
        const window = sessionListWindow(sessions(3), 25, undefined);
        expect(window.visibleSessions).toHaveLength(3);
        expect(window.hiddenCount).toBe(0);
    });

    it('keeps the selected Session visible when it sits past the window', () => {
        const window = sessionListWindow(sessions(12), undefined, 'session-9');
        expect(window.visibleSessions.at(-1)?.id).toBe('session-9');
        expect(window.hiddenCount).toBe(3);
    });

    it('ignores a selected Session that belongs to another Project', () => {
        const window = sessionListWindow(sessions(12), undefined, 'session-from-elsewhere');
        expect(window.visibleSessions).toHaveLength(DEFAULT_VISIBLE_SESSION_COUNT);
    });

    it('handles a Project with no Sessions', () => {
        const window = sessionListWindow([], undefined, undefined);
        expect(window.visibleSessions).toEqual([]);
        expect(window.hiddenCount).toBe(0);
    });
});

describe('nextRevealedSessionCount', () => {
    it('adds one step to what is on screen', () => {
        expect(nextRevealedSessionCount(DEFAULT_VISIBLE_SESSION_COUNT)).toBe(
            DEFAULT_VISIBLE_SESSION_COUNT + SESSION_REVEAL_STEP,
        );
    });

    it('steps from a selection-widened window so the reveal row keeps its promise', () => {
        const widened = sessionListWindow(sessions(30), undefined, 'session-9');
        expect(widened.visibleSessions).toHaveLength(9);
        const revealed = sessionListWindow(
            sessions(30),
            nextRevealedSessionCount(widened.visibleSessions.length),
            'session-9',
        );
        expect(revealed.visibleSessions.length - widened.visibleSessions.length).toBe(
            widened.nextRevealCount,
        );
    });
});
