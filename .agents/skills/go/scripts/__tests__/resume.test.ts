import { describe, expect, it } from 'vitest';

import { createResumeCheckpoint, formatResumeCheckpoint } from '../resume';
import { createInitialState, transitionState, upsertIssue } from '../state-model';

describe('Go resume checkpoint', () => {
    it('derives the next action from the current issue drift state', () => {
        const state = createInitialState({ objective: 'Resume safely', runId: 'resume-issue' });
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        upsertIssue(state, { number: 163, status: 'progressing', title: 'Add script tests' });

        expect(createResumeCheckpoint(state).nextAction).toBe(
            'Assess expectation drift for issue #163',
        );
        state.issues[0].expectationDrift.status = 'detected';
        expect(createResumeCheckpoint(state)).toMatchObject({
            blockers: ['Issue #163 has unpublished material expectation drift'],
            nextAction: 'Publish the material expectation-drift comment for issue #163',
        });
        state.issues[0].expectationDrift.status = 'decision_required';
        expect(createResumeCheckpoint(state).nextAction).toBe(
            'Request the recorded scope decision for issue #163',
        );
    });

    it('surfaces pending validation and mutation ownership without reading event history', () => {
        const state = createInitialState({ objective: 'Resume validation', runId: 'resume-gate' });
        state.mutationLease = {
            acquiredAt: '2026-08-21T00:00:00.000Z',
            holderId: 'repair-owner',
            kind: 'repair',
        };
        state.validations.push({
            argumentCount: 0,
            arguments: [],
            artifactVersion: 0,
            attempt: 1,
            childPid: null,
            childIdentity: null,
            command: 'bun run test',
            commandDigest: null,
            completedAt: null,
            durationMs: null,
            executable: null,
            exitCode: null,
            headSha: 'head',
            id: 'validation-1',
            integrityError: null,
            kind: 'gates',
            lineageId: 'tests',
            logByteLength: null,
            logError: null,
            logIntegrityError: null,
            logMetadata: null,
            logPath: 'validation/tests.log',
            logSha256: null,
            result: 'pending',
            runnerPid: null,
            runnerIdentity: null,
            sessionId: 'session-1',
            signal: null,
            sourceFingerprint: 'fixture-fingerprint',
            startedAt: '2026-08-21T00:00:00.000Z',
            termination: null,
        });

        const checkpoint = createResumeCheckpoint(state);
        expect(checkpoint.blockers).toEqual([
            'A validation command has no final process result',
            'Repair mutation lease is active: repair-owner',
        ]);
        expect(formatResumeCheckpoint(checkpoint)).toContain(
            'pending-validation: validation-1 session=session-1 runner=unknown child=unknown log=validation/tests.log command=bun run test',
        );
    });
});
