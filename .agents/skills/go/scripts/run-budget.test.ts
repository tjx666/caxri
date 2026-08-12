import { describe, expect, it } from 'vitest';

import { createEmptyReviewGate } from './review-gate';
import { createRunBudget, recordCostCheckpoint, routeWorkflowWork } from './run-budget';

function budgetState() {
    return {
        phase: 'issue_execution',
        reviewGate: createEmptyReviewGate(),
        runBudget: createRunBudget(),
        validations: [] as Array<{ attempt: number }>,
    };
}

describe('Go run budget', () => {
    it('records available metrics without inventing unavailable token data', () => {
        const state = budgetState();
        recordCostCheckpoint(state, {
            commitCount: 2,
            elapsedSeconds: 90,
            fileCount: 8,
            tokens: 'unavailable',
        });

        expect(state.runBudget.checkpoints).toEqual([
            expect.objectContaining({
                commitCount: 2,
                hardThresholdReached: false,
                tokens: 'unavailable',
            }),
        ]);
    });

    it('routes only non-blocking workflow work after a hard threshold', () => {
        const state = budgetState();
        recordCostCheckpoint(state, {
            commitCount: 10,
            elapsedSeconds: state.runBudget.policy.hardElapsedSeconds,
            fileCount: 40,
            tokens: 200_000,
        });

        expect(routeWorkflowWork(state, { blocking: false, title: 'General CI cleanup' })).toBe(
            'follow_up',
        );
        expect(
            routeWorkflowWork(state, { blocking: true, title: 'Fix broken delivery gate' }),
        ).toBe('current');
        routeWorkflowWork(state, { blocking: false, title: 'General CI cleanup' });
        expect(state.runBudget.routedWork).toHaveLength(1);
    });
});
