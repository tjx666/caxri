import { beforeEach, describe, expect, it } from 'vitest';

import type { SessionNavigationHistorySnapshot } from '../session-navigation-history';
import {
    applySessionNavigation,
    pruneSessionHistory,
    recordSessionVisit,
    sessionNavigationTarget,
    useSessionNavigationHistoryStore,
} from '../session-navigation-history';

function snapshot(
    overrides: Partial<SessionNavigationHistorySnapshot> = {},
): SessionNavigationHistorySnapshot {
    return { back: [], current: undefined, forward: [], ...overrides };
}

/**
 * What the navigation buttons show: the confirmed history with every unconfirmed request folded in.
 */
function visible(): SessionNavigationHistorySnapshot {
    const { back, current, forward } = useSessionNavigationHistoryStore.getState();
    return { back, current, forward };
}

/**
 * The history the workbench has actually shown, which no failed or overtaken request may corrupt.
 */
function confirmed(): SessionNavigationHistorySnapshot {
    return useSessionNavigationHistoryStore.getState().confirmed;
}

describe('Session navigation history', () => {
    beforeEach(() => {
        useSessionNavigationHistoryStore.getState().reset();
    });

    it('stacks ordinary visits and truncates the forward history', () => {
        let state = recordSessionVisit(snapshot(), 'session-a');
        state = recordSessionVisit(state, 'session-b');
        expect(state).toEqual(snapshot({ back: ['session-a'], current: 'session-b' }));

        state = applySessionNavigation(state, 'back');
        expect(state).toEqual(snapshot({ current: 'session-a', forward: ['session-b'] }));

        state = recordSessionVisit(state, 'session-c');
        expect(state).toEqual(snapshot({ back: ['session-a'], current: 'session-c' }));
    });

    it('keeps back and forward symmetric', () => {
        const start = snapshot({ back: ['session-a'], current: 'session-b' });
        expect(applySessionNavigation(applySessionNavigation(start, 'back'), 'forward')).toEqual(
            start,
        );
    });

    it('ignores a re-observed current Session and an empty selection', () => {
        const state = snapshot({ back: ['session-a'], current: 'session-b' });
        expect(recordSessionVisit(state, 'session-b')).toBe(state);
        expect(recordSessionVisit(state, undefined)).toEqual(
            snapshot({ back: ['session-a'], current: undefined }),
        );
    });

    it('leaves a direction with no target untouched', () => {
        const state = snapshot({ back: ['session-a'], current: 'session-b' });
        expect(applySessionNavigation(state, 'forward')).toBe(state);
        expect(sessionNavigationTarget(state, 'forward')).toBeUndefined();
    });

    it('drops archived and deleted Sessions from both stacks', () => {
        const state = snapshot({
            back: ['gone', 'session-a'],
            current: 'session-b',
            forward: ['archived'],
        });
        expect(pruneSessionHistory(state, ['session-a', 'session-b'])).toEqual(
            snapshot({ back: ['session-a'], current: 'session-b' }),
        );
        expect(pruneSessionHistory(state, ['gone', 'session-a', 'session-b', 'archived'])).toBe(
            state,
        );
    });

    /**
     * `A → B → A` then archiving B leaves `back: ['session-a']` while `session-a` is already on screen. Without
     * collapsing that top entry, Back stays enabled forever and every press re-selects the current Session.
     */
    it('drops stack entries that pruning left equal to the current Session', () => {
        expect(
            pruneSessionHistory(
                snapshot({ back: ['session-a', 'session-b'], current: 'session-a' }),
                ['session-a'],
            ),
        ).toEqual(snapshot({ back: [], current: 'session-a' }));
        expect(
            pruneSessionHistory(
                snapshot({ current: 'session-a', forward: ['session-b', 'session-a'] }),
                ['session-a'],
            ),
        ).toEqual(snapshot({ current: 'session-a', forward: [] }));
    });

    it('caps the remembered visits', () => {
        let state = recordSessionVisit(snapshot(), 'session-0');
        for (let index = 1; index <= 60; index++) {
            state = recordSessionVisit(state, `session-${index}`);
        }
        expect(state.back).toHaveLength(50);
        expect(state.back[0]).toBe('session-10');
        expect(state.current).toBe('session-60');
    });

    /**
     * The Runtime confirms a Session switch asynchronously, so a second navigation routinely lands before the first one
     * is observed. Both must compute from the state the user can already see, which is why the queued requests are
     * projected on top of the confirmed history, and why the late confirmations must not move it a second time.
     */
    it('lets a second navigation build on the first before the Runtime confirms it', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        store.observe('session-c');
        expect(store.request('back')).toBe('session-b');
        expect(store.request('back')).toBe('session-a');
        const navigated = snapshot({ current: 'session-a', forward: ['session-c', 'session-b'] });
        expect(visible()).toEqual(navigated);

        // Both confirmations arrive in request order, the first one naming a Session no longer on screen.
        store.observe('session-b');
        expect(visible()).toEqual(navigated);
        store.observe('session-a');
        expect(visible()).toEqual(navigated);
        expect(confirmed()).toEqual(navigated);
        expect(useSessionNavigationHistoryStore.getState().queue).toEqual([]);
    });

    it('treats Back then Forward at that same speed as an exact no-op', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        store.observe('session-c');
        const before = visible();
        expect(store.request('back')).toBe('session-b');
        expect(store.request('forward')).toBe('session-c');
        expect(visible()).toEqual(before);
    });

    /**
     * A Session the user genuinely reached must survive, even when it arrives out of order: the confirmed history is
     * what the workbench really showed, so the late confirmation stacks on top of it rather than on the optimistic
     * projection the overtaking selection already invalidated.
     */
    it('hands the history to an ordinary selection that overtakes a navigation', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        expect(store.request('back')).toBe('session-a');

        // A Session created and selected from the Sidebar resolved first, so it owns the history from `session-b`.
        store.observe('session-c');
        expect(visible()).toEqual(
            snapshot({ back: ['session-a', 'session-b'], current: 'session-c' }),
        );

        // Only then does the Back land, as an ordinary visit — `session-c` was on screen and must stay reachable.
        store.observe('session-a');
        expect(visible()).toEqual(
            snapshot({ back: ['session-a', 'session-b', 'session-c'], current: 'session-a' }),
        );
    });

    it('ignores a snapshot that re-reports the Session already recorded', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        expect(store.request('back')).toBeUndefined();
        store.observe('session-b');
        expect(store.request('back')).toBe('session-a');

        const pending = visible();
        store.observe('session-b');
        expect(visible()).toEqual(pending);
        expect(useSessionNavigationHistoryStore.getState().queue).toHaveLength(1);
    });

    it('forgets queued navigations to Sessions archived mid-flight', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        expect(store.request('back')).toBe('session-a');

        store.prune(['session-b']);
        expect(useSessionNavigationHistoryStore.getState().queue).toEqual([]);
        expect(visible()).toEqual(snapshot({ current: 'session-b' }));

        // The refused selection lands afterwards and must not bring the archived Session back.
        store.abandon('session-a');
        expect(visible()).toEqual(snapshot({ current: 'session-b' }));
    });

    /**
     * Rolling the visible stacks back would be wrong here: the confirmed history never moved, so dropping the refused
     * step and everything queued behind it — those were computed on top of a step that never happened — is enough.
     */
    it('drops a refused navigation together with the steps queued behind it', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        store.observe('session-c');
        expect(store.request('back')).toBe('session-b');
        expect(store.request('back')).toBe('session-a');

        store.abandon('session-b');
        expect(useSessionNavigationHistoryStore.getState().queue).toEqual([]);
        expect(visible()).toEqual(
            snapshot({ back: ['session-a', 'session-b'], current: 'session-c' }),
        );
    });

    /**
     * `A → B → A`: both Backs name `session-a`, so a refusal must be matched by position rather than by Session, or the
     * rollback would cut the queue at the wrong step.
     */
    it('cuts the queue at the oldest occurrence when the same Session is queued twice', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        store.observe('session-a');
        store.observe('session-c');
        expect(store.request('back')).toBe('session-a');
        expect(store.request('back')).toBe('session-b');
        expect(store.request('back')).toBe('session-a');

        store.abandon('session-a');
        expect(useSessionNavigationHistoryStore.getState().queue).toEqual([]);
        expect(visible()).toEqual(
            snapshot({ back: ['session-a', 'session-b', 'session-a'], current: 'session-c' }),
        );
    });

    it('refuses to queue more navigations than a stalled Runtime could ever confirm', () => {
        const store = useSessionNavigationHistoryStore.getState();
        for (let index = 0; index <= 40; index++) {
            store.observe(`session-${index}`);
        }

        const targets: Array<string | undefined> = [];
        for (let index = 0; index < 20; index++) {
            targets.push(store.request('back'));
        }
        expect(targets.filter(Boolean)).toHaveLength(16);
        expect(targets.at(-1)).toBeUndefined();
        expect(useSessionNavigationHistoryStore.getState().queue).toHaveLength(16);
    });

    it('reports the next target in each direction', () => {
        const state = snapshot({
            back: ['session-a', 'session-b'],
            current: 'session-c',
            forward: ['session-e', 'session-d'],
        });
        expect(sessionNavigationTarget(state, 'back')).toBe('session-b');
        expect(sessionNavigationTarget(state, 'forward')).toBe('session-d');
        expect(sessionNavigationTarget(snapshot(), 'back')).toBeUndefined();
    });
});
