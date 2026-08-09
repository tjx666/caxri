import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    createInitialState,
    recordAcceptance,
    recordNote,
    recordPullRequest,
    transitionState,
    upsertIssue,
    validateState,
    writeInitialState,
} from './state';

describe('Go state ledger', () => {
    it('tracks delivery state and rejects invalid transitions', () => {
        const state = createInitialState({
            branch: 'feat/go',
            objective: 'Deliver two issues',
            runId: 'test-run',
        });

        expect(state.phase).toBe('intake');
        expect(state.status).toBe('planning');
        transitionState(state, 'planning', 'requirements resolved');
        transitionState(state, 'issue_execution', 'goal created');

        upsertIssue(state, {
            checks: ['issue-42-layout'],
            number: 42,
            priority: 'P0',
            status: 'progressing',
            title: 'Fix terminal layout',
        });
        upsertIssue(state, {
            checks: ['issue-42-layout'],
            commits: ['abc1234', 'abc1234'],
            number: 42,
            status: 'complete',
            validations: ['focused test passed'],
        });

        expect(state.issues[0].acceptanceCheckIds).toEqual(['issue-42-layout']);
        expect(state.issues[0].commits).toEqual(['abc1234']);
        expect(state.issues[0].status).toBe('complete');

        transitionState(state, 'deep_review');
        transitionState(state, 'delivery');
        recordPullRequest(state, {
            number: 123,
            status: 'ready',
            url: 'https://github.com/example/repo/pull/123',
        });
        transitionState(state, 'acceptance');
        recordAcceptance(state, {
            id: 'acc_test',
            round: 1,
            status: 'pending',
            url: 'https://app.lobehub.com/acceptance/acc_test',
        });
        transitionState(state, 'waiting_acceptance');
        recordNote(state, { kind: 'workflow', text: 'Capture evidence after aggregate review' });
        recordNote(state, { kind: 'workflow', text: 'Capture evidence after aggregate review' });

        expect(state.notes.workflow).toHaveLength(1);
        expect(validateState(state)).toEqual(state);
        expect(() => transitionState(state, 'complete')).toThrow('Invalid phase transition');
    });

    it('rejects invalid issue dependencies', () => {
        const state = createInitialState({ objective: 'Validate dependencies', runId: 'test-run' });

        expect(() =>
            upsertIssue(state, {
                dependencies: [Number.NaN],
                number: 43,
                title: 'Invalid dependency',
            }),
        ).toThrow('positive integers');
    });

    it('requires completed issues and the exact accepted PR head before merge', () => {
        const state = createInitialState({ objective: 'Protect merge', runId: 'merge-test' });
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        upsertIssue(state, { number: 44, status: 'queued', title: 'Finish delivery' });

        transitionState(state, 'deep_review');
        expect(() => validateState(state)).toThrow('unfinished issues #44');

        upsertIssue(state, { commits: ['abc123'], number: 44, status: 'complete' });
        expect(validateState(state).phase).toBe('deep_review');
        transitionState(state, 'delivery');
        recordPullRequest(state, { headSha: 'abc123', number: 124, status: 'ready' });
        transitionState(state, 'acceptance');
        recordAcceptance(state, { round: 1, status: 'pending' });
        transitionState(state, 'waiting_acceptance');
        transitionState(state, 'merge');
        expect(() => validateState(state)).toThrow('exact human-accepted PR head');

        recordAcceptance(state, {
            acceptedHeadSha: 'different-head',
            status: 'accepted',
        });
        expect(() => validateState(state)).toThrow('exact human-accepted PR head');

        recordAcceptance(state, { acceptedHeadSha: 'abc123', status: 'accepted' });
        expect(validateState(state).phase).toBe('merge');
    });

    it('does not overwrite an existing run ledger', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-go-state-'));
        const path = join(directory, 'state.json');
        const state = createInitialState({ objective: 'Keep resume history', runId: 'same-run' });

        try {
            await writeInitialState(path, state);
            await expect(writeInitialState(path, state)).rejects.toThrow('Go run already exists');
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});
