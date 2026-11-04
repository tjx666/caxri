import { describe, expect, it } from 'vitest';

import {
    delegationOrigin,
    handBackView,
    originReturnNoteKey,
} from '../agent-chat-delegation-origin';

const parent = { id: 'p1', title: 'Plan the release' };

describe('delegationOrigin', () => {
    it('describes a delegated or consult child whose parent is open', () => {
        expect(delegationOrigin({ createdByRelation: 'delegated' }, parent, undefined)).toEqual({
            control: 'delegated',
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

describe('hand-back control', () => {
    const originFor = (
        takenOverAt: number | undefined,
        control?: 'delegated' | 'handback_pending' | 'human',
    ) =>
        delegationOrigin(
            { createdByRelation: 'delegated' },
            parent,
            takenOverAt,
            'parent',
            control,
        )!;

    it('reads who holds the Session from the feed, and from the takeover time without it', () => {
        expect(originFor(1).control).toBe('human');
        expect(originFor(undefined).control).toBe('delegated');
        expect(originFor(1, 'handback_pending')).toMatchObject({
            control: 'handback_pending',
            isTakenOver: true,
        });
    });

    it('treats a Session the delegating Agent took up again as delegated, though it was taken over before', () => {
        expect(originFor(1, 'delegated')).toMatchObject({
            isTakenOver: false,
            isWaitingOnParent: true,
        });
    });

    it('shows nothing while delegated and a waiting note while the hand-back is pending', () => {
        const idle = { hasDraft: false, isBusy: false };
        expect(handBackView(originFor(undefined), idle)).toEqual({ kind: 'hidden' });
        expect(handBackView(originFor(1, 'handback_pending'), idle)).toEqual({ kind: 'pending' });
    });

    it('offers the button once taken over, disabled with the first reason that applies', () => {
        const origin = originFor(1);
        expect(handBackView(origin, { hasDraft: false, isBusy: false })).toEqual({
            kind: 'available',
        });
        expect(handBackView(origin, { hasDraft: true, isBusy: false })).toEqual({
            kind: 'available',
            block: 'draft',
        });
        expect(handBackView(origin, { hasDraft: true, isBusy: true })).toEqual({
            kind: 'available',
            block: 'busy',
        });
        expect(
            handBackView({ ...origin, isParentArchived: true }, { hasDraft: true, isBusy: true }),
        ).toEqual({ kind: 'available', block: 'parent_archived' });
    });
});
