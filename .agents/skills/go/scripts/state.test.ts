import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    createInitialState,
    recordAcceptance,
    recordNote,
    recordPullRequest,
    statePathForRunId,
    transitionState,
    upsertIssue,
    validateState,
    writeInitialState,
} from './state';
import { createResumeCheckpoint, formatResumeCheckpoint } from './resume';

describe('Go state ledger', () => {
    it('rejects path-like run IDs before resolving the ledger path', () => {
        expect(() => statePathForRunId('../../../../tmp/untrusted-run')).toThrow(
            'Go run ID must be a single path segment',
        );
        expect(statePathForRunId('valid-run')).toMatch(/\.records\/go\/valid-run\/state\.json$/);
    });

    it('does not follow a symlinked run directory during CLI initialization', async () => {
        const outsideDirectory = await mkdtemp(join(tmpdir(), 'caxri-go-symlink-'));
        const runId = `symlink-${outsideDirectory.split('/').at(-1)}`;
        const statePath = statePathForRunId(runId);
        const runDirectory = dirname(statePath);

        try {
            await mkdir(dirname(runDirectory), { recursive: true });
            await symlink(outsideDirectory, runDirectory, 'dir');

            const child = spawn(
                'bun',
                [
                    'run',
                    '.agents/skills/go/scripts/state.ts',
                    'init',
                    '--objective',
                    'Reject symlink traversal',
                    '--run-id',
                    runId,
                ],
                { cwd: process.cwd(), stdio: 'pipe' },
            );
            const exitCode = await new Promise<number | null>((resolve, reject) => {
                child.once('error', reject);
                child.once('close', resolve);
            });

            expect(exitCode).toBe(1);
            await expect(access(join(outsideDirectory, 'state.json'))).rejects.toThrow();
        } finally {
            await rm(runDirectory, { force: true });
            await rm(outsideDirectory, { force: true, recursive: true });
        }
    });

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
            headSha: 'pr-head-123',
            number: 123,
            status: 'checks_blocked',
            url: 'https://github.com/example/repo/pull/123',
        });
        expect(state.pullRequest.status).toBe('checks_blocked');
        recordPullRequest(state, { status: 'ready' });
        transitionState(state, 'acceptance');
        recordAcceptance(state, {
            id: 'acc_test',
            round: 1,
            status: 'pending',
            url: 'https://app.lobehub.com/acceptance/acc_test',
        });
        transitionState(state, 'waiting_acceptance');
        recordNote(state, { kind: 'workflow', text: '在综合 review 后再捕获最终证据。' });
        recordNote(state, { kind: 'workflow', text: '在综合 review 后再捕获最终证据。' });

        expect(state.notes.workflow).toHaveLength(1);
        expect(createResumeCheckpoint(state)).toMatchObject({
            acceptance: { status: 'pending' },
            blockers: [],
            currentIssue: null,
            nextAction: 'Yield to the user and query Acceptance once on the next continuation',
            phase: 'waiting_acceptance',
            pullRequest: { number: 123, status: 'ready' },
            remainingIssues: [],
        });
        expect(formatResumeCheckpoint(createResumeCheckpoint(state))).toContain(
            'acceptance: pending round 1\n',
        );
        expect(formatResumeCheckpoint(createResumeCheckpoint(state))).not.toContain(
            'acceptance: pending round 1 @ pr-head-123',
        );
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

    it('summarizes only actionable resume state', () => {
        const state = createInitialState({ objective: 'Resume compactly', runId: 'resume-test' });
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        upsertIssue(state, { number: 45, status: 'complete', title: 'Finished issue' });
        upsertIssue(state, { number: 46, status: 'progressing', title: 'Current issue' });

        const checkpoint = createResumeCheckpoint(state);

        expect(checkpoint.currentIssue).toEqual({
            number: 46,
            status: 'progressing',
            title: 'Current issue',
        });
        expect(checkpoint.nextAction).toBe('Continue issue #46: Current issue');
        expect(checkpoint.remainingIssues).toHaveLength(1);
        expect(checkpoint).not.toHaveProperty('events');
        expect(checkpoint).not.toHaveProperty('notes');
    });

    it('surfaces a compact workflow summary only at the Acceptance handoff', () => {
        const state = createInitialState({
            objective: 'Summarize learnings',
            runId: 'handoff-test',
        });
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        expect(() =>
            recordNote(state, { kind: 'workflow', text: 'English workflow observation.' }),
        ).toThrow('workflow note must be primarily Chinese');
        recordNote(state, { kind: 'workflow', text: '丢弃最早的一条观察。' });
        recordNote(state, { kind: 'workflow', text: '保持稳定的 check id。' });
        recordNote(state, { kind: 'workflow', text: '只冻结一次 requirement。' });
        recordNote(state, { kind: 'workflow', text: '逐一检查每张 screenshot。' });

        expect(createResumeCheckpoint(state).workflowObservations).toEqual([]);
        transitionState(state, 'deep_review');
        transitionState(state, 'delivery');
        recordPullRequest(state, { headSha: 'handoff-head', status: 'ready' });
        transitionState(state, 'acceptance');

        const checkpoint = createResumeCheckpoint(state);
        expect(checkpoint.workflowObservations).toEqual([
            '保持稳定的 check id。',
            '只冻结一次 requirement。',
            '逐一检查每张 screenshot。',
        ]);
        expect(formatResumeCheckpoint(checkpoint)).toContain(
            'workflow observations:\n- 保持稳定的 check id。\n- 只冻结一次 requirement。\n- 逐一检查每张 screenshot。',
        );
    });

    it('surfaces accumulated workflow and token-waste notes during final reporting', () => {
        const state = createInitialState({ objective: 'Report audit notes', runId: 'audit-test' });
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        transitionState(state, 'deep_review');
        transitionState(state, 'delivery');
        recordPullRequest(state, { headSha: 'audit-head', status: 'ready' });
        transitionState(state, 'acceptance');
        recordAcceptance(state, {
            acceptedHeadSha: 'audit-head',
            status: 'accepted',
        });
        transitionState(state, 'waiting_acceptance');
        recordNote(state, { kind: 'token_waste', text: 'Repeated a large status query.' });
        recordNote(state, { kind: 'workflow', text: '把重复证据捕获步骤做成脚本。' });
        transitionState(state, 'merge');
        transitionState(state, 'self_improvement');

        const checkpoint = createResumeCheckpoint(state);
        expect(checkpoint.auditNotes).toEqual({
            tokenWaste: ['Repeated a large status query.'],
            truncated: false,
            workflow: ['把重复证据捕获步骤做成脚本。'],
        });
        expect(formatResumeCheckpoint(checkpoint)).toContain(
            'report audit notes:\n- token_waste: Repeated a large status query.\n- workflow: 把重复证据捕获步骤做成脚本。',
        );
    });

    it('migrates schema version 2 ledgers with an empty fallback record', () => {
        const current = createInitialState({
            objective: 'Resume old ledger',
            runId: 'legacy-test',
        });
        const legacy = { ...current, schemaVersion: 2 } as Record<string, unknown>;
        delete legacy.ciFallback;

        expect(validateState(legacy)).toMatchObject({
            ciFallback: { status: 'not_requested' },
            schemaVersion: 3,
        });
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
