import { describe, expect, it } from 'vitest';

import { delegationOrigin, originReturnNoteKey } from '../agent-chat-delegation-origin';

const parent = { id: 'p1', title: 'Plan the release' };

describe('delegationOrigin', () => {
    it('describes a delegated or consult child whose parent is open', () => {
        expect(delegationOrigin({ createdByRelation: 'delegated' }, parent, undefined)).toEqual({
            isParentArchived: false,
            isTakenOver: false,
            isWaitingOnParent: false,
            parent,
        });
        expect(delegationOrigin({ createdByRelation: 'consult' }, parent, undefined)).toMatchObject(
            { isTakenOver: false },
        );
    });

    it('marks an archived parent so the row names it without a way back', () => {
        expect(
            delegationOrigin({ createdByRelation: 'delegated' }, { ...parent, archivedAt: 5 }, 1),
        ).toMatchObject({ isParentArchived: true, isTakenOver: true });
    });

    it('says nothing for a hand-off, an unrelated Session, or a parent that is gone', () => {
        expect(
            delegationOrigin({ createdByRelation: 'handoff' }, parent, undefined),
        ).toBeUndefined();
        expect(delegationOrigin({}, parent, undefined)).toBeUndefined();
        expect(
            delegationOrigin({ createdByRelation: 'delegated' }, undefined, undefined),
        ).toBeUndefined();
    });

    it('waits on the delegating Agent only while its question is unescalated and not taken over', () => {
        const waits = (takenOverAt: number | undefined, waitingOn?: 'parent' | 'user') =>
            delegationOrigin({ createdByRelation: 'delegated' }, parent, takenOverAt, waitingOn)
                ?.isWaitingOnParent;
        expect(waits(undefined, 'parent')).toBe(true);
        expect(waits(undefined, 'user')).toBe(false);
        expect(waits(undefined)).toBe(false);
        expect(waits(1, 'parent')).toBe(false);
    });

    it('reads a takeover from the time the Server recorded', () => {
        expect(delegationOrigin({ createdByRelation: 'delegated' }, parent, 1_700)).toMatchObject({
            isTakenOver: true,
        });
    });
});

describe('originReturnNoteKey', () => {
    it('words a held question and a held permission request apart, and never calls a question an approval', () => {
        const key = (hasApproval: boolean, isEscalated: boolean, isWaitingOnParent: boolean) =>
            originReturnNoteKey({ hasApproval, isEscalated, isWaitingOnParent });
        expect(key(false, false, true)).toBe('delegation.origin.waitingForParent');
        expect(key(true, false, true)).toBe('delegation.origin.waitingForApproval');
        expect(key(false, true, false)).toBe('delegation.origin.waitingForYou');
        expect(key(true, true, false)).toBe('delegation.origin.waitingForYourApproval');
        expect(key(true, false, false)).toBe('delegation.origin.autoReturn');
    });
});
