import { describe, expect, it } from 'vitest';

import { independentOrigin } from '../agent-chat-independent-origin';

const creator = { id: 'c1', title: 'Plan the release' };

describe('independentOrigin', () => {
    it('names the creator of an independent Session, and a way back while it is open', () => {
        expect(independentOrigin({ createdByRelation: 'independent' }, creator)).toEqual({
            isParentArchived: false,
            parent: creator,
        });
    });

    it('names an archived creator without a way back', () => {
        expect(
            independentOrigin({ createdByRelation: 'independent' }, { ...creator, archivedAt: 5 }),
        ).toMatchObject({ isParentArchived: true });
    });

    it('says nothing for another relation, an unrelated Session, or a creator that is gone', () => {
        for (const createdByRelation of ['delegated', 'consult', 'handoff'] as const)
            expect(independentOrigin({ createdByRelation }, creator)).toBeUndefined();
        expect(independentOrigin({}, creator)).toBeUndefined();
        expect(independentOrigin({ createdByRelation: 'independent' }, undefined)).toBeUndefined();
    });
});
