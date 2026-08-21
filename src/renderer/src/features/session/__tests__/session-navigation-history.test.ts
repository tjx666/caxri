import { beforeEach, describe, expect, it } from 'vitest';

import type { SessionNavigationHistorySnapshot } from '../session-navigation-history';
import {
    applySessionNavigation,
    pruneSessionHistory,
    recordSessionVisit,
    sessionNavigationSnapshot,
    sessionNavigationTarget,
    useSessionNavigationHistoryStore,
} from '../session-navigation-history';

function snapshot(
    overrides: Partial<SessionNavigationHistorySnapshot> = {},
): SessionNavigationHistorySnapshot {
    return { back: [], current: undefined, forward: [], ...overrides };
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
     * is observed. Both must compute from the state the user can already see, which is why `request` moves the stacks
     * immediately instead of remembering an intent, and why the late confirmations must not move them a second time.
     */
    it('lets a second navigation build on the first before the Runtime confirms it', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        store.observe('session-c');
        expect(store.request('back')).toBe('session-b');
        expect(store.request('back')).toBe('session-a');
        const navigated = snapshot({ current: 'session-a', forward: ['session-c', 'session-b'] });
        expect(sessionNavigationSnapshot()).toEqual(navigated);

        // Both confirmations arrive in request order, the first one naming a Session no longer on screen.
        store.observe('session-b');
        expect(sessionNavigationSnapshot()).toEqual(navigated);
        store.observe('session-a');
        expect(sessionNavigationSnapshot()).toEqual(navigated);
        expect(useSessionNavigationHistoryStore.getState().pendingTargets).toEqual([]);
    });

    it('treats Back then Forward at that same speed as an exact no-op', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        store.observe('session-c');
        const before = sessionNavigationSnapshot();
        expect(store.request('back')).toBe('session-b');
        expect(store.request('forward')).toBe('session-c');
        expect(sessionNavigationSnapshot()).toEqual(before);
    });

    it('hands the history to an ordinary selection that overtakes a navigation', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        expect(store.request('back')).toBe('session-a');

        // A Sidebar click resolved first, so its Session owns the history and the stale confirmation is just a visit.
        store.observe('session-c');
        store.observe('session-a');
        expect(sessionNavigationSnapshot()).toEqual(
            snapshot({ back: ['session-a', 'session-c'], current: 'session-a' }),
        );
    });

    it('forgets pending confirmations for Sessions archived mid-flight', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        expect(store.request('back')).toBe('session-a');
        store.prune(['session-b']);
        expect(useSessionNavigationHistoryStore.getState().pendingTargets).toEqual([]);
    });

    it('rolls a failed navigation back, unless something moved on first', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        const before = sessionNavigationSnapshot();
        expect(store.request('back')).toBe('session-a');

        store.restore(before, 'session-a');
        expect(sessionNavigationSnapshot()).toEqual(before);

        // A rollback that arrives after the user has selected something else must not resurrect the stale stacks.
        expect(store.request('back')).toBe('session-a');
        store.observe('session-c');
        const afterUnrelatedSelection = sessionNavigationSnapshot();
        store.restore(before, 'session-a');
        expect(sessionNavigationSnapshot()).toEqual(afterUnrelatedSelection);
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
