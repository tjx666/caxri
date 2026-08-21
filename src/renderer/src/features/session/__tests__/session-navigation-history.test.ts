import { beforeEach, describe, expect, it } from 'vitest';

import type { SessionNavigationHistorySnapshot } from '../session-navigation-history';
import {
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

describe('Session navigation history', () => {
    beforeEach(() => {
        useSessionNavigationHistoryStore.getState().reset();
    });

    it('stacks ordinary visits and truncates the forward history', () => {
        let state = recordSessionVisit(snapshot(), 'session-a');
        state = recordSessionVisit(state, 'session-b');
        expect(state).toEqual(snapshot({ back: ['session-a'], current: 'session-b' }));

        state = recordSessionVisit(state, 'session-a', 'back');
        expect(state).toEqual(snapshot({ current: 'session-a', forward: ['session-b'] }));

        state = recordSessionVisit(state, 'session-c');
        expect(state).toEqual(snapshot({ back: ['session-a'], current: 'session-c' }));
    });

    it('replays the forward stack and keeps back and forward symmetric', () => {
        let state = snapshot({ back: ['session-a'], current: 'session-b' });
        state = recordSessionVisit(state, 'session-a', 'back');
        state = recordSessionVisit(state, 'session-b', 'forward');
        expect(state).toEqual(snapshot({ back: ['session-a'], current: 'session-b' }));
    });

    it('treats a selection that is not the requested target as an ordinary visit', () => {
        const state = recordSessionVisit(
            snapshot({ back: ['session-a'], current: 'session-b' }),
            'session-c',
            'back',
        );
        expect(state).toEqual(snapshot({ back: ['session-a', 'session-b'], current: 'session-c' }));
    });

    it('ignores a re-observed current Session and an empty selection', () => {
        const state = snapshot({ back: ['session-a'], current: 'session-b' });
        expect(recordSessionVisit(state, 'session-b')).toBe(state);
        expect(recordSessionVisit(state, undefined)).toEqual(
            snapshot({ back: ['session-a'], current: undefined }),
        );
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

    it('caps the remembered visits', () => {
        let state = recordSessionVisit(snapshot(), 'session-0');
        for (let index = 1; index <= 60; index++) {
            state = recordSessionVisit(state, `session-${index}`);
        }
        expect(state.back).toHaveLength(50);
        expect(state.back[0]).toBe('session-10');
        expect(state.current).toBe('session-60');
    });

    it('keeps the requested direction until the workbench actually switches', () => {
        const store = useSessionNavigationHistoryStore.getState();
        store.observe('session-a');
        store.observe('session-b');
        expect(store.request('back')).toBe('session-a');

        // A refresh that still reports the current Session must not consume the pending direction.
        store.observe('session-b');
        store.observe('session-a');
        expect(useSessionNavigationHistoryStore.getState()).toMatchObject({
            back: [],
            current: 'session-a',
            forward: ['session-b'],
            pending: undefined,
        });
        expect(store.request('forward')).toBe('session-b');
        expect(store.request('back')).toBeUndefined();
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
