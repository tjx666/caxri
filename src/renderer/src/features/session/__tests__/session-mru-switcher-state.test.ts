import type { SessionRecord } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    resolveSessionMruNavigation,
    sessionMruCandidates,
    useSessionMruSwitcherStore,
} from '../session-mru-switcher-state';

function session(
    id: string,
    lastOpenedAt: number,
    overrides: Partial<SessionRecord> = {},
): SessionRecord {
    return {
        id,
        projectId: 'project-1',
        workbenchProjectId: 'project-1',
        rootPath: '/project',
        createdAt: lastOpenedAt,
        lastOpenedAt,
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        layoutVersion: 2,
        displayTitle: id,
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
            heldModifiers: ['Control', 'Alt'],
            triggerCode: 'Tab',
        });
        store.cycle(1);
        expect(useSessionMruSwitcherStore.getState().selectedIndex).toBe(1);
        store.cycle(-1);
        expect(useSessionMruSwitcherStore.getState().commit()).toBe('session-b');
        expect(useSessionMruSwitcherStore.getState().isOpen).toBe(false);
    });

    it('does not reveal the overlay during a quick press and release', () => {
        const store = useSessionMruSwitcherStore.getState();
        store.beginOrCycle(['session-b'], {
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
                heldModifiers: [],
                triggerCode: 'KeyM',
            }),
        ).toBe('session-b');
        expect(useSessionMruSwitcherStore.getState().isOpen).toBe(false);
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
