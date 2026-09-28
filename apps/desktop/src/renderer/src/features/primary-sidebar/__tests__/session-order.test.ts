import type { SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    frozenSessionOrder,
    keyboardReorderTarget,
    sessionDropTarget,
    sessionIdsKey,
    sessionMoveAnnouncement,
} from '../session-order';

function session(id: string, projectId = 'p'): SessionRecord {
    return {
        id,
        projectId,
        workbenchProjectId: projectId,
        rootPath: '/fixture',
        createdAt: 0,
        lastOpenedAt: 0,
        lastSessionActivityAt: 0,
        sidebarOrder: 0,
        lastSessionActivityReason: 'created',
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        displayTitle: id,
        titleMode: 'automatic',
    };
}

describe('Session drag order', () => {
    it('freezes positions while retaining fresh status and dropping removed rows', () => {
        const a = { ...session('a'), lastActivityState: 'waiting' as const };
        const b = session('b');
        expect(frozenSessionOrder([b, a, session('new')], ['a', 'deleted', 'b'])).toEqual([a, b]);
        const rows = [b, a];
        expect(frozenSessionOrder(rows)).toBe(rows);
    });
    it('accepts only a distinct active anchor in the same Project', () => {
        const rows = [
            session('a'),
            session('b'),
            session('foreign', 'other'),
            { ...session('archived'), archivedAt: 1 },
        ];
        expect(sessionDropTarget(rows, 'a', 'b', 'after')).toEqual({
            anchorSessionId: 'b',
            placement: 'after',
        });
        for (const id of ['a', 'foreign', 'archived', 'missing'])
            expect(sessionDropTarget(rows, 'a', id, 'before')).toBeUndefined();
        expect(sessionDropTarget(rows, undefined, 'b', 'before')).toBeUndefined();
    });
});

describe('Session row identity across a Session switch', () => {
    /**
     * Issue #1356: a switch re-sends the opened Session with a new `lastOpenedAt`, so the list and that record are new
     * objects while no row moved. The key the rows' shared id list is memoized on must not change with them.
     */
    it('keys a list by membership and order, not by record identity', () => {
        const before = [session('a'), session('b')];
        const after = [{ ...session('a'), lastOpenedAt: 1 }, session('b')];
        expect(sessionIdsKey(after)).toBe(sessionIdsKey(before));
        expect(sessionIdsKey([session('b'), session('a')])).not.toBe(sessionIdsKey(before));
        expect(sessionIdsKey([session('a')])).not.toBe(sessionIdsKey(before));
    });

    it('cannot confuse two lists whose ids share a separator', () => {
        expect(sessionIdsKey([session('a,b')])).not.toBe(
            sessionIdsKey([session('a'), session('b')]),
        );
    });
});

describe('Keyboard Session reordering', () => {
    const byProject = (row: SessionRecord): string => row.projectId;

    it('anchors a move on the neighbor among the rows the list shows', () => {
        const rows = [session('a'), session('b'), session('c')];
        const visibleSessionIds = ['a', 'b', 'c'];
        expect(
            keyboardReorderTarget({
                direction: 1,
                groupOf: byProject,
                sessionId: 'b',
                sessions: rows,
                visibleSessionIds,
            }),
        ).toEqual({ anchorSessionId: 'c', placement: 'after' });
        expect(
            keyboardReorderTarget({
                direction: -1,
                groupOf: byProject,
                sessionId: 'b',
                sessions: rows,
                visibleSessionIds,
            }),
        ).toEqual({ anchorSessionId: 'a', placement: 'before' });
    });

    it('stops at either end of the shown rows instead of moving into the hidden tail', () => {
        const rows = [session('a'), session('b'), session('hidden')];
        const visibleSessionIds = ['a', 'b'];
        for (const [sessionId, direction] of [
            ['a', -1],
            ['b', 1],
        ] as const)
            expect(
                keyboardReorderTarget({
                    direction,
                    groupOf: byProject,
                    sessionId,
                    sessions: rows,
                    visibleSessionIds,
                }),
            ).toBeUndefined();
    });

    it('resolves the shown ids against the current records', () => {
        // `b` was archived and `c` moved to another Project after the row last rendered its id list.
        const rows = [session('a'), session('c', 'other'), session('d')];
        expect(
            keyboardReorderTarget({
                direction: 1,
                groupOf: byProject,
                sessionId: 'a',
                sessions: rows,
                visibleSessionIds: ['a', 'b', 'c', 'd'],
            }),
        ).toEqual({ anchorSessionId: 'd', placement: 'after' });
        expect(
            keyboardReorderTarget({
                direction: 1,
                groupOf: byProject,
                sessionId: 'b',
                sessions: rows,
                visibleSessionIds: ['a', 'b', 'd'],
            }),
        ).toBeUndefined();
    });

    it('treats every row as one group when the list spans Projects', () => {
        const rows = [session('a'), session('b', 'other')];
        expect(
            keyboardReorderTarget({
                direction: 1,
                groupOf: () => 'pinned',
                sessionId: 'a',
                sessions: rows,
                visibleSessionIds: ['a', 'b'],
            }),
        ).toEqual({ anchorSessionId: 'b', placement: 'after' });
    });

    it('announces a move by the titles the rows had when it started', () => {
        const rows = [
            { ...session('a'), displayTitle: 'Alpha' },
            { ...session('b'), displayTitle: 'Beta' },
        ];
        expect(
            sessionMoveAnnouncement(rows, 'a', { anchorSessionId: 'b', placement: 'after' }),
        ).toBe('Moved Alpha after Beta');
        expect(
            sessionMoveAnnouncement(rows, 'gone', { anchorSessionId: 'b', placement: 'before' }),
        ).toBe('Moved Session before Beta');
    });
});
