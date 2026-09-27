import type { SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { frozenSessionOrder, sessionDropTarget } from '../session-order';

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
