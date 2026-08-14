import { describe, expect, it } from 'vitest';

import { createEmptyReviewGate } from '../review-gate';
import {
    createRunBudget,
    recordCostCheckpoint,
    routeWorkflowWork,
    updateRunBudgetPolicy,
} from '../run-budget';

function budgetState() {
    return {
        createdAt: '2026-08-12T00:00:00.000Z',
        phase: 'issue_execution',
        reviewGate: createEmptyReviewGate(),
        runBudget: createRunBudget(),
        validations: [] as Array<{ attempt: number }>,
    };
}

describe('Go run budget', () => {
    it('records available metrics without inventing unavailable token data', () => {
        const state = budgetState();
        recordCostCheckpoint(
            state,
            {
                commitCount: 2,
                fileCount: 8,
                tokens: 'unavailable',
            },
            '2026-08-12T00:01:30.000Z',
        );

        expect(state.runBudget.checkpoints).toEqual([
            expect.objectContaining({
                commitCount: 2,
                elapsedSeconds: 90,
                hardThresholdReached: false,
                tokenTelemetry: 'degraded',
                tokens: 'unavailable',
            }),
        ]);
    });

    it('routes only non-blocking workflow work after a hard threshold', () => {
        const state = budgetState();
        recordCostCheckpoint(
            state,
            {
                commitCount: 10,
                fileCount: 40,
                tokens: 200_000,
            },
            '2026-08-12T01:30:00.000Z',
        );

        expect(routeWorkflowWork(state, { blocking: false, title: 'General CI cleanup' })).toBe(
            'follow_up',
        );
        expect(
            routeWorkflowWork(state, { blocking: true, title: 'Fix broken delivery gate' }),
        ).toBe('current');
        routeWorkflowWork(state, { blocking: false, title: 'General CI cleanup' });
        expect(state.runBudget.routedWork).toHaveLength(1);
    });

    it('appends issue checkpoints and freezes the intake policy', () => {
        const state = budgetState();
        recordCostCheckpoint(state, { boundary: 'issue', issueNumber: 1 }, '2026-08-12T00:01:00Z');
        recordCostCheckpoint(state, { boundary: 'issue', issueNumber: 2 }, '2026-08-12T00:02:00Z');
        expect(state.runBudget.checkpoints.map(({ issueNumber }) => issueNumber)).toEqual([1, 2]);

        state.runBudget.policyFrozenAt = '2026-08-12T00:00:10Z';
        expect(() =>
            updateRunBudgetPolicy(state, {
                ...state.runBudget.policy,
                hardTokens: 2_000_000,
            }),
        ).toThrow('cannot change after intake');
    });
});
