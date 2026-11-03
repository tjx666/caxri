import { MAX_DELEGATION_CREATORS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    delegationFeedCreatorIdChunks,
    failedDelegationSessionIds,
    isDelegationFailed,
} from '../delegation-feed';

describe('delegationFeedCreatorIdChunks', () => {
    it('asks about the distinct direct creators, sorted, in one chunk', () => {
        expect(
            delegationFeedCreatorIdChunks([
                { createdBySessionId: 'b' },
                { createdBySessionId: 'a' },
                { createdBySessionId: 'b' },
                { createdBySessionId: undefined },
            ]),
        ).toEqual([['a', 'b']]);
    });

    it('returns no chunk when no nested Session has a creator', () => {
        expect(delegationFeedCreatorIdChunks([])).toEqual([]);
        expect(delegationFeedCreatorIdChunks([{ createdBySessionId: undefined }])).toEqual([]);
    });

    it('produces the same chunks whatever order the Sessions arrive in', () => {
        const forward = ['x', 'y', 'z'].map((id) => ({ createdBySessionId: id }));
        expect(delegationFeedCreatorIdChunks(forward)).toEqual(
            delegationFeedCreatorIdChunks(forward.toReversed()),
        );
    });

    it('splits at the most creators one read accepts', () => {
        const count = MAX_DELEGATION_CREATORS + 5;
        const sessions = Array.from({ length: count }, (_, index) => ({
            createdBySessionId: `creator-${String(index).padStart(3, '0')}`,
        }));
        const chunks = delegationFeedCreatorIdChunks(sessions);
        expect(chunks.map((chunk) => chunk.length)).toEqual([MAX_DELEGATION_CREATORS, 5]);
        expect(chunks.flat()).toHaveLength(count);
    });
});

describe('isDelegationFailed', () => {
    it('counts only the failed status', () => {
        expect(isDelegationFailed({ status: 'failed' })).toBe(true);
        for (const status of [
            'requested',
            'launching',
            'awaiting_ready',
            'submitting',
            'running',
            'collecting',
            'completed',
            'blocked',
            'human_intervened',
            'interrupted',
            'answer_unavailable',
            undefined,
        ] as const)
            expect(isDelegationFailed({ status })).toBe(false);
    });
});

describe('failedDelegationSessionIds', () => {
    it('lists the failed Sessions sorted, so an unchanged answer keeps its identity', () => {
        expect(
            failedDelegationSessionIds([
                { sessionId: 'c', status: 'failed' },
                { sessionId: 'a', status: 'completed' },
                { sessionId: 'b', status: 'failed' },
                { sessionId: 'd', status: undefined },
            ]),
        ).toEqual(['b', 'c']);
    });
});
