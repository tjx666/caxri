import { describe, expect, it } from 'vitest';

import { acquireMutationLease, releaseMutationLease } from '../mutation-lease';

describe('Go worktree mutation lease', () => {
    it('allows one durable writer and keeps repair and validation mutually exclusive', () => {
        const state = { mutationLease: null };
        acquireMutationLease(state, { holderId: 'repair-1', kind: 'repair' });

        expect(() =>
            acquireMutationLease(state, { holderId: 'validation-1', kind: 'validation' }),
        ).toThrow('held by repair:repair-1');
        expect(() => releaseMutationLease(state, { holderId: 'other', kind: 'repair' })).toThrow(
            'belongs to repair:repair-1',
        );

        releaseMutationLease(state, { holderId: 'repair-1', kind: 'repair' });
        expect(() =>
            acquireMutationLease(state, { holderId: 'validation-1', kind: 'validation' }),
        ).not.toThrow();
    });
});
