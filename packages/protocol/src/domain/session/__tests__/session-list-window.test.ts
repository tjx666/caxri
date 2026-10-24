import { describe, expect, it } from 'vitest';

import {
    DEFAULT_VISIBLE_SESSION_COUNT,
    nextRevealedSessionCount,
    revealedCountIncluding,
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

    it('pins the selected Session to the end of the window without revealing its neighbours', () => {
        const window = sessionListWindow(sessions(12), undefined, 'session-9');
        expect(window.visibleSessions.map((session) => session.id)).toEqual([
            'session-1',
            'session-2',
            'session-3',
            'session-4',
            'session-5',
            'session-9',
        ]);
        expect(window.windowCount).toBe(DEFAULT_VISIBLE_SESSION_COUNT);
        // The reveal row survives the selection, so the Projects below keep their place.
        expect(window.hiddenCount).toBe(6);
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
    it('adds one step to the in-order window', () => {
        expect(nextRevealedSessionCount(DEFAULT_VISIBLE_SESSION_COUNT)).toBe(
            DEFAULT_VISIBLE_SESSION_COUNT + SESSION_REVEAL_STEP,
        );
    });

    /**
     * The reveal row's label is a promise, and a pinned selected Session is already on screen. Both cases below would
     * otherwise miscount it: absorbing the pin into the next window adds one row fewer than promised, and leaving it
     * pinned adds one more.
     */
    it.each([
        ['absorbs the pinned Session', 20, 'session-13'],
        ['leaves the pinned Session outside the next window', 40, 'session-21'],
        ['has no pinned Session at all', 40, undefined],
        ['finishes the list in one step', 12, 'session-9'],
    ])('adds exactly what the reveal row promised when it %s', (_case, total, selectedId) => {
        const before = sessionListWindow(sessions(total), undefined, selectedId);
        const after = sessionListWindow(
            sessions(total),
            nextRevealedSessionCount(before.windowCount),
            selectedId,
        );
        expect(after.visibleSessions.length - before.visibleSessions.length).toBe(
            before.nextRevealCount,
        );
    });

    it('promises nothing once the list is complete', () => {
        expect(sessionListWindow(sessions(3), undefined, 'session-3').nextRevealCount).toBe(0);
    });
});

describe('revealedCountIncluding', () => {
    it('opens the window down to a Session below it', () => {
        expect(revealedCountIncluding(7, DEFAULT_VISIBLE_SESSION_COUNT)).toBe(8);
    });

    it('leaves the window alone when the Session is already inside it', () => {
        expect(revealedCountIncluding(4, DEFAULT_VISIBLE_SESSION_COUNT)).toBeUndefined();
        expect(revealedCountIncluding(0, DEFAULT_VISIBLE_SESSION_COUNT)).toBeUndefined();
    });
});
