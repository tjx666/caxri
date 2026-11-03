import { agentDelegationFailureSchema, MAX_DELEGATION_CREATORS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { delegationCopy } from '../delegation-copy';
import {
    collapseRetryChains,
    delegationAttemptNumbers,
    delegationAttentionCounts,
    delegationElapsedMs,
    delegationFeedCreatorIdChunks,
    failedDelegationSessionIds,
    isDelegationFailed,
    isDelegationNeedsInput,
    isRetryCandidate,
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

    it('does not count a failed status whose failure is a takeover, a refusal or a stop', () => {
        expect(isDelegationFailed({ status: 'failed', failure: 'human_input' })).toBe(false);
        expect(isDelegationFailed({ status: 'failed', failure: 'target_changed' })).toBe(false);
        expect(isDelegationFailed({ status: 'failed', failure: 'quota_exhausted' })).toBe(true);
        expect(isDelegationFailed({ status: 'failed' })).toBe(true);
    });

    it('agrees with the red cross of delegationCopy for every failure value', () => {
        for (const failure of agentDelegationFailureSchema.options)
            expect(isDelegationFailed({ status: 'failed', failure })).toBe(
                delegationCopy({ status: 'failed', failure }, 0, translate).glyph === 'failed',
            );
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
                { sessionId: 'e', status: 'failed', failure: 'human_input' },
            ]),
        ).toEqual(['b', 'c']);
    });
});

describe('delegationAttentionCounts', () => {
    it('counts waiting-on-you and failed tasks apart, and counts answer_unavailable as neither', () => {
        expect(
            delegationAttentionCounts([
                { status: 'blocked', failure: 'permission_required' },
                { status: 'blocked', failure: 'startup_waiting' },
                { status: 'failed', failure: 'quota_exhausted' },
                { status: 'answer_unavailable', failure: 'result_missing' },
                { status: 'completed' },
                { status: 'running' },
                { status: 'interrupted', failure: 'caller_stopped' },
                {},
            ]),
        ).toEqual({ failed: 1, needsInput: 2 });
    });
});

describe('isDelegationNeedsInput', () => {
    it('is a blocked task asking for input, not every blocked task or a failed one', () => {
        expect(isDelegationNeedsInput({ status: 'blocked', failure: 'permission_required' })).toBe(
            true,
        );
        expect(isDelegationNeedsInput({ status: 'blocked', failure: 'startup_waiting' })).toBe(
            true,
        );
        expect(isDelegationNeedsInput({ status: 'blocked' })).toBe(false);
        expect(isDelegationNeedsInput({ status: 'failed', failure: 'permission_required' })).toBe(
            false,
        );
    });
});

describe('delegationElapsedMs', () => {
    it('runs to the settling time, or to now while the task is active', () => {
        expect(delegationElapsedMs({ createdAt: 1000, settledAt: 4000 }, 9000)).toBe(3000);
        expect(delegationElapsedMs({ createdAt: 1000, status: 'running' }, 9000)).toBe(8000);
    });

    it('has no duration without a task or before its creation', () => {
        expect(delegationElapsedMs({}, 9000)).toBeUndefined();
        expect(delegationElapsedMs({ createdAt: 10_000 }, 9000)).toBeUndefined();
    });
});

describe('isRetryCandidate', () => {
    const failed = { delegationId: 'd1', failure: 'quota_exhausted', status: 'failed' } as const;

    it('offers a retryable failure nothing has retried', () => {
        expect(isRetryCandidate(failed)).toBe(true);
    });

    it('refuses a retried, taken-over, non-retryable, or unidentified task', () => {
        expect(isRetryCandidate({ ...failed, retriedAs: 'd2' })).toBe(false);
        expect(isRetryCandidate({ ...failed, takenOverAt: 5 })).toBe(false);
        expect(isRetryCandidate({ ...failed, failure: 'human_input' })).toBe(false);
        expect(isRetryCandidate({ ...failed, failure: undefined })).toBe(false);
        expect(isRetryCandidate({ ...failed, status: 'interrupted' })).toBe(false);
        expect(isRetryCandidate({ ...failed, delegationId: undefined })).toBe(false);
    });
});

describe('collapseRetryChains', () => {
    it('drops a failure whose fresh retry is in the list', () => {
        const entries = [
            { delegationId: 'f1', retriedAs: 'n1' },
            { delegationId: 'n1', retryOf: 'f1' },
        ];
        expect(collapseRetryChains(entries).map((entry) => entry.delegationId)).toEqual(['n1']);
    });

    it('keeps the failure when its successor is not in the list', () => {
        const entries = [{ delegationId: 'f1', retriedAs: 'gone' }, { delegationId: 'other' }];
        expect(collapseRetryChains(entries)).toEqual(entries);
    });

    it('drops the original of a mixed chain: fresh, then resume of the successor', () => {
        // The successor Session now shows its newest receipt n2, which retries n1; f1 still names n1.
        const entries = [
            { delegationId: 'f1', retriedAs: 'n1' },
            { delegationId: 'n2', retryOf: 'n1' },
        ];
        expect(collapseRetryChains(entries).map((entry) => entry.delegationId)).toEqual(['n2']);
    });

    it('keeps unrelated entries in order', () => {
        const entries = [{ delegationId: 'a' }, { delegationId: 'b' }];
        expect(collapseRetryChains(entries)).toEqual(entries);
    });

    it('lets the header count only the surviving attempt', () => {
        const entries = [
            { delegationId: 'f1', failure: 'quota_exhausted', retriedAs: 'n1', status: 'failed' },
            { delegationId: 'n1', retryOf: 'f1', status: 'running' },
        ] as const;
        expect(delegationAttentionCounts(entries)).toEqual({ failed: 1, needsInput: 0 });
        expect(delegationAttentionCounts(collapseRetryChains(entries))).toEqual({
            failed: 0,
            needsInput: 0,
        });
    });
});

describe('delegationAttemptNumbers', () => {
    it('numbers a retry 2 and a retry of a retry 3, leaving first attempts absent', () => {
        const attempts = delegationAttemptNumbers([
            { delegationId: 'a' },
            { delegationId: 'b', retryOf: 'a' },
            { delegationId: 'c', retryOf: 'b' },
        ]);
        expect(attempts.get('a')).toBeUndefined();
        expect(attempts.get('b')).toBe(2);
        expect(attempts.get('c')).toBe(3);
    });

    it('counts a resume retry whose failed task is no longer listed as attempt 2', () => {
        expect(delegationAttemptNumbers([{ delegationId: 'n', retryOf: 'gone' }]).get('n')).toBe(2);
    });
});

describe('failedDelegationSessionIds with retries', () => {
    it('leaves out a failure a retry superseded', () => {
        expect(
            failedDelegationSessionIds([
                { failure: 'quota_exhausted', retriedAs: 'n1', sessionId: 's1', status: 'failed' },
                { failure: 'quota_exhausted', sessionId: 's2', status: 'failed' },
            ]),
        ).toEqual(['s2']);
    });
});
