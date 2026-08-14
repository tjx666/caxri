import { describe, expect, it } from 'vitest';

import { assessExpectationDrift } from '../issue-drift';
import { createInitialState, transitionState, upsertIssue } from '../state-model';

describe('Go issue progress checkpoints', () => {
    it('retains one issue checkpoint per completed item instead of overwriting the phase', () => {
        const state = createInitialState({
            objective: 'Track issue progress',
            runId: 'issues-test',
        });
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        for (let number = 1; number <= 12; number += 1) {
            upsertIssue(state, { number, status: 'progressing', title: `Issue ${number}` });
            assessExpectationDrift(state, {
                driftKey: 'final-assessment',
                headSha: `head-${number}`,
                issueNumber: number,
                kind: 'internal_detail',
            });
            upsertIssue(state, {
                commits: [`head-${number}`],
                number,
                status: 'complete',
            });
        }

        expect(
            state.runBudget.checkpoints.filter(({ boundary }) => boundary === 'issue'),
        ).toHaveLength(12);

        upsertIssue(state, { number: 12, status: 'complete' });
        expect(
            state.runBudget.checkpoints.filter(({ boundary }) => boundary === 'issue'),
        ).toHaveLength(12);
    });
});
