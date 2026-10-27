import type { SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { pinnedSessionDropTarget, pinnedSessions, unpinnedSessions } from '../pinned-session-order';

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        createdAt: 0,
        title: id,
        id,
        projectId: 'alpha',
        sidebarOrder: 0,
        updatedAt: 0,
        ...overrides,
    } as SessionRecord;
}

describe('pinnedSessions', () => {
    it('keeps only pinned Sessions, in Pinned order', () => {
        const sessions = [
            session('a', { pinnedAt: 10, pinnedOrder: 2 }),
            session('b'),
            session('c', { pinnedAt: 20, pinnedOrder: 1 }),
        ];
        expect(pinnedSessions(sessions).map((row) => row.id)).toEqual(['c', 'a']);
    });

    it('orders a Session that has never been dragged by when it was pinned', () => {
        const sessions = [
            session('later', { pinnedAt: 200, pinnedOrder: 0 }),
            session('earlier', { pinnedAt: 100, pinnedOrder: 0 }),
        ];
        expect(pinnedSessions(sessions).map((row) => row.id)).toEqual(['earlier', 'later']);
    });

    it('drops an archived Session even while it still carries a pin', () => {
        const sessions = [session('a', { archivedAt: 5, pinnedAt: 10, pinnedOrder: 0 })];
        expect(pinnedSessions(sessions)).toEqual([]);
    });
});

describe('unpinnedSessions', () => {
    it('withholds every pinned Session from the Project groups, keeping the rest in order', () => {
        const sessions = [
            session('a', { pinnedAt: 10, pinnedOrder: 0 }),
            session('b'),
            session('c', { pinnedAt: 20, pinnedOrder: 1 }),
            session('d'),
        ];
        expect(unpinnedSessions(sessions).map((row) => row.id)).toEqual(['b', 'd']);
    });

    it('leaves every row standing when nothing is pinned', () => {
        const sessions = [session('a'), session('b')];
        expect(unpinnedSessions(sessions).map((row) => row.id)).toEqual(['a', 'b']);
    });

    it('splits the list with pinnedSessions, so no Session is listed twice or lost', () => {
        const sessions = [
            session('a', { pinnedAt: 10, pinnedOrder: 0 }),
            session('b'),
            session('c', { pinnedAt: 20, pinnedOrder: 1 }),
        ];
        const listed = [...pinnedSessions(sessions), ...unpinnedSessions(sessions)].map(
            (row) => row.id,
        );
        expect(listed.toSorted((left, right) => left.localeCompare(right))).toEqual([
            'a',
            'b',
            'c',
        ]);
    });
});

describe('pinnedSessionDropTarget', () => {
    const sessions = [
        session('a', { pinnedAt: 10, pinnedOrder: 0 }),
        session('b', { pinnedAt: 20, pinnedOrder: 1, projectId: 'beta' }),
        session('loose'),
    ];

    it('accepts a drop between two Projects, which is what the group is for', () => {
        expect(pinnedSessionDropTarget(sessions, 'a', 'b', 'after')).toEqual({
            anchorSessionId: 'b',
            placement: 'after',
        });
    });

    it('refuses a drag that started outside the Pinned group', () => {
        expect(pinnedSessionDropTarget(sessions, 'loose', 'b', 'before')).toBeUndefined();
    });

    it('refuses an anchor that is not pinned', () => {
        expect(pinnedSessionDropTarget(sessions, 'a', 'loose', 'before')).toBeUndefined();
    });

    it('refuses a row dropped on itself', () => {
        expect(pinnedSessionDropTarget(sessions, 'a', 'a', 'after')).toBeUndefined();
    });
});
