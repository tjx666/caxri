import { describe, expect, it } from 'vitest';

import {
    reconcileUnpublishedAcceptanceRound,
    recordPublishedAcceptance,
} from '../acceptance-publication';
import { createInitialState } from '../state-model';

describe('Go Acceptance publication reconciliation', () => {
    it('reconciles only one locally incremented unpublished round', () => {
        const state = createInitialState({ objective: 'Reconcile Acceptance', runId: 'reconcile' });
        state.phase = 'acceptance';
        state.pullRequest.headSha = 'head-1';
        for (const roundIndex of [1, 2]) {
            recordPublishedAcceptance(state, {
                acceptanceId: 'acc-1',
                checkIds: ['acceptance-round-lineage'],
                headSha: 'head-1',
                publishedAt: `2026-08-12T00:0${roundIndex}:00.000Z`,
                roundIndex,
                url: 'https://app.lobehub.com/acceptance/acc-1',
                verdict: 'partial',
                verifyRunId: `run-${roundIndex}`,
            });
        }
        state.acceptance.round = 3;
        state.acceptance.status = 'running';

        reconcileUnpublishedAcceptanceRound(state, {
            reason: 'Round was announced before the publication wrapper owned the increment.',
            round: 2,
        });
        expect(state.acceptance.round).toBe(2);

        expect(() =>
            reconcileUnpublishedAcceptanceRound(state, {
                reason: 'A second rollback is not valid.',
                round: 1,
            }),
        ).toThrow('one unpublished increment');
    });
});
