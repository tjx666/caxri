import type { SessionRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    resolveSessionMruNavigation,
    resolveSessionMruView,
    sessionMruCandidates,
    useSessionMruSwitcherStore,
} from '../session-mru-switcher-state';

function session(
    id: string,
    lastVisitedAt: number,
    overrides: Partial<SessionRecord> = {},
): SessionRecord {
    return {
        id,
        projectId: 'project-1',
        workbenchRootProjectId: 'project-1',
        rootPath: '/project',
        createdAt: lastVisitedAt,
        lastVisitedAt,
        sidebarOrder: 0,
        sessionActivityAt: lastVisitedAt,
        sessionActivityReason: 'created',
        agentActivityState: 'idle',
        attentionGeneration: 0,
        acknowledgedAttentionGeneration: 0,
        hasUnread: false,
        title: id,
        titleMode: 'automatic',
        ...overrides,
    };
}

describe('Session MRU switcher state', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        useSessionMruSwitcherStore.getState().cancel();
    });

    it('orders active candidates by persisted activation time and excludes the current Session', () => {
        expect(
            sessionMruCandidates(
                [
                    session('session-a', 10),
                    session('session-b', 30),
                    session('session-c', 20),
                    session('archived', 40, { archivedAt: 50 }),
                ],
                'session-b',
            ).map(({ id }) => id),
        ).toEqual(['session-c', 'session-a']);
    });

    it('cycles in both directions and commits the highlighted Session', () => {
        const store = useSessionMruSwitcherStore.getState();
        store.beginOrCycle(['session-b', 'session-a'], {
            direction: 1,
            heldModifiers: ['Control', 'Alt'],
            triggerCode: 'Tab',
        });
        store.cycle(1);
        expect(useSessionMruSwitcherStore.getState().selectedIndex).toBe(1);
        store.cycle(-1);
        expect(useSessionMruSwitcherStore.getState().commit()).toBe('session-b');
        expect(useSessionMruSwitcherStore.getState().isOpen).toBe(false);
    });

    it('opens on the last candidate when the initial shortcut requests reverse navigation', () => {
        const store = useSessionMruSwitcherStore.getState();
        store.beginOrCycle(['session-b', 'session-a', 'session-c'], {
            direction: -1,
            heldModifiers: ['Meta'],
            triggerCode: 'Backquote',
        });

        expect(useSessionMruSwitcherStore.getState().selectedIndex).toBe(2);
        expect(store.commit()).toBe('session-c');
    });

    it('commits the candidate a pointer highlighted and ignores out-of-range rows', () => {
        const store = useSessionMruSwitcherStore.getState();
        store.beginOrCycle(['session-b', 'session-a', 'session-c'], {
            direction: 1,
            heldModifiers: ['Control', 'Alt'],
            triggerCode: 'Tab',
        });
        store.select(2);
        expect(useSessionMruSwitcherStore.getState().selectedIndex).toBe(2);
        store.select(3);
        store.select(-1);
        expect(useSessionMruSwitcherStore.getState().selectedIndex).toBe(2);
        expect(store.commit()).toBe('session-c');
    });

    it('ignores pointer selection while the switcher is closed', () => {
        const store = useSessionMruSwitcherStore.getState();
        store.select(1);
        expect(useSessionMruSwitcherStore.getState().selectedIndex).toBe(0);
        expect(useSessionMruSwitcherStore.getState().isOpen).toBe(false);
    });

    it('does not reveal the overlay during a quick press and release', () => {
        const store = useSessionMruSwitcherStore.getState();
        store.beginOrCycle(['session-b'], {
            direction: 1,
            heldModifiers: ['Control', 'Alt'],
            triggerCode: 'Tab',
        });
        expect(store.commit()).toBe('session-b');
        vi.runAllTimers();
        expect(useSessionMruSwitcherStore.getState().isVisible).toBe(false);
    });

    it('performs a one-shot MRU jump when no modifier is held', () => {
        expect(
            useSessionMruSwitcherStore.getState().beginOrCycle(['session-b', 'session-a'], {
                direction: 1,
                heldModifiers: [],
                triggerCode: 'KeyM',
            }),
        ).toBe('session-b');
        expect(useSessionMruSwitcherStore.getState().isOpen).toBe(false);
    });

    it('clamps the view selection and safely empties when candidates disappear during refresh', () => {
        const available = session('session-b', 2);
        expect(resolveSessionMruView(['removed', available.id], [available], 1)).toEqual({
            candidates: [available],
            selected: available,
            selectedIndex: 0,
        });
        expect(resolveSessionMruView(['removed'], [], 0)).toEqual({
            candidates: [],
            selected: undefined,
            selectedIndex: -1,
        });
    });

    it('commits the candidate displayed after a selected Session disappears', () => {
        const store = useSessionMruSwitcherStore.getState();
        store.beginOrCycle(['session-a', 'session-b', 'session-c'], {
            direction: 1,
            heldModifiers: ['Control', 'Alt'],
            triggerCode: 'Tab',
        });
        store.cycle(1);

        expect(store.commit(['session-a', 'session-c'])).toBe('session-c');
    });

    it('excludes archived candidates from the live switcher view', () => {
        expect(
            resolveSessionMruView(
                ['session-a', 'session-b'],
                [session('session-a', 1, { archivedAt: 2 }), session('session-b', 2)],
                0,
            ),
        ).toMatchObject({ selected: { id: 'session-b' }, selectedIndex: 0 });
    });

    it('uses pending logical selection while the Runtime snapshot is stale', () => {
        const sessions = [
            session('session-a', 1),
            session('session-b', 4, { createdAt: 2 }),
            session('session-c', 3),
        ];

        expect(
            resolveSessionMruNavigation(sessions, 'session-b', {
                currentSessionId: 'session-c',
                previousSessionId: 'session-b',
            }),
        ).toEqual({
            candidateIds: ['session-b', 'session-a'],
            pendingSelection: {
                currentSessionId: 'session-c',
                previousSessionId: 'session-b',
            },
            selectedSessionId: 'session-c',
        });
    });

    it('drops pending navigation after Runtime confirms it', () => {
        const sessions = [
            session('session-a', 1),
            session('session-b', 4, { createdAt: 2 }),
            session('session-c', 5, { createdAt: 3 }),
        ];

        expect(
            resolveSessionMruNavigation(sessions, 'session-c', {
                currentSessionId: 'session-c',
                previousSessionId: 'session-b',
            }),
        ).toEqual({
            candidateIds: ['session-b', 'session-a'],
            selectedSessionId: 'session-c',
        });
    });
});
