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
import { recordReviewDecision } from './review-gate';

function freezeReview(state: ReturnType<typeof createInitialState>, headSha: string) {
    recordReviewDecision(state, {
        freeze: true,
        headSha,
        mode: 'full',
        p0: 0,
        p1: 0,
        scope: 'Goal range',
    });
}

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
        freezeReview(state, 'pr-head-123');
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

    it('requires an explicit review-clean head freeze before delivery', () => {
        const state = createInitialState({ objective: 'Freeze delivery', runId: 'freeze-test' });
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        transitionState(state, 'deep_review');

        expect(() => transitionState(state, 'delivery')).toThrow(
            'explicitly frozen review-clean head',
        );
        freezeReview(state, 'frozen-head');
        expect(() => transitionState(state, 'delivery')).not.toThrow();
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
        freezeReview(state, 'abc123');
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
        freezeReview(state, 'handoff-head');
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
        freezeReview(state, 'audit-head');
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
            reviewGate: { frozenHeadSha: null, rounds: [] },
            schemaVersion: 5,
            validationBudget: { fullElectronE2eRuns: [] },
        });
    });

    it('imports a pre-v4 delivery review as an unfrozen baseline', () => {
        const current = createInitialState({ objective: 'Migrate delivery', runId: 'legacy-v3' });
        transitionState(current, 'planning');
        transitionState(current, 'issue_execution');
        transitionState(current, 'deep_review');
        freezeReview(current, 'legacy-head');
        transitionState(current, 'delivery');
        recordPullRequest(current, { headSha: 'legacy-head', status: 'checks_blocked' });
        const legacy = { ...current, schemaVersion: 3 } as Record<string, unknown>;
        delete legacy.reviewGate;
        delete legacy.validationBudget;

        expect(validateState(legacy)).toMatchObject({
            reviewGate: {
                frozenHeadSha: null,
                rounds: [{ headSha: 'legacy-head', mode: 'full' }],
            },
            schemaVersion: 5,
        });
    });

    it('backfills v4 review phases around the recorded delivery transition', () => {
        const current = createInitialState({
            objective: 'Migrate review phases',
            runId: 'legacy-v4',
        });
        transitionState(current, 'planning');
        transitionState(current, 'issue_execution');
        transitionState(current, 'deep_review');
        freezeReview(current, 'product-head');
        recordReviewDecision(current, {
            freeze: true,
            headSha: 'pre-delivery-head',
            mode: 'verification',
            p0: 0,
            p1: 0,
            scope: 'Pre-delivery bookkeeping',
        });
        transitionState(current, 'delivery');
        for (const headSha of ['delivery-head-1', 'delivery-head-2']) {
            recordReviewDecision(current, {
                freeze: true,
                headSha,
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Delivery repair',
            });
        }
        const deliveryTransitionIndex = current.events.findIndex(
            ({ detail, type }) => type === 'phase' && detail.startsWith('deep_review -> delivery'),
        );
        current.events.splice(
            deliveryTransitionIndex,
            0,
            {
                at: current.reviewGate.rounds[0].completedAt,
                detail: 'full review for product-head: P0=0 P1=0 (frozen)',
                type: 'review',
            },
            {
                at: current.reviewGate.rounds[1].completedAt,
                detail: 'verification review for pre-delivery-head: P0=0 P1=0 (frozen)',
                type: 'review',
            },
        );
        current.events.push(
            {
                at: current.reviewGate.rounds[2].completedAt,
                detail: 'verification review for delivery-head-1: P0=0 P1=0 (frozen)',
                type: 'review',
            },
            {
                at: current.reviewGate.rounds[3].completedAt,
                detail: 'verification review for delivery-head-2: P0=0 P1=0 (frozen)',
                type: 'review',
            },
        );
        for (const decision of current.reviewGate.rounds) {
            Reflect.deleteProperty(decision, 'phase');
        }
        const legacy = { ...current, schemaVersion: 4 } as Record<string, unknown>;

        const migrated = validateState(legacy);
        expect(migrated.schemaVersion).toBe(5);
        expect(migrated.reviewGate.rounds.map(({ phase }) => phase)).toEqual([
            'deep_review',
            'deep_review',
            'delivery',
            'delivery',
        ]);
        recordReviewDecision(migrated, {
            freeze: true,
            headSha: 'delivery-head-3',
            mode: 'verification',
            p0: 0,
            p1: 0,
            scope: 'Final delivery repair',
        });
        expect(() =>
            recordReviewDecision(migrated, {
                freeze: true,
                headSha: 'delivery-head-4',
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Excess delivery repair',
            }),
        ).toThrow('requires explicit user authorization');
        recordReviewDecision(migrated, {
            authorization: 'User approved one final delivery verification.',
            freeze: true,
            headSha: 'delivery-head-4',
            mode: 'verification',
            p0: 0,
            p1: 0,
            scope: 'Authorized final delivery repair',
        });
        expect(() =>
            recordReviewDecision(migrated, {
                freeze: true,
                headSha: 'delivery-head-5',
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Unauthorized fifth delivery repair',
            }),
        ).toThrow('requires explicit user authorization');
        recordReviewDecision(migrated, {
            authorization: 'User approved one systemic CI-parity verification.',
            freeze: true,
            headSha: 'delivery-head-5',
            mode: 'verification',
            p0: 0,
            p1: 0,
            scope: 'Authorized systemic delivery repair',
        });
        expect(() =>
            recordReviewDecision(migrated, {
                authorization: 'User approved another delivery verification.',
                freeze: true,
                headSha: 'delivery-head-6',
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Disallowed sixth delivery repair',
            }),
        ).toThrow('five delivery-stage');
    });

    it('replays every v4 delivery and deep-review cycle while backfilling phases', () => {
        const current = createInitialState({
            objective: 'Migrate review cycles',
            runId: 'legacy-v4-cycles',
        });
        transitionState(current, 'planning');
        transitionState(current, 'issue_execution');
        transitionState(current, 'deep_review');
        freezeReview(current, 'product-head');
        recordReviewDecision(current, {
            freeze: true,
            headSha: 'pre-delivery-head',
            mode: 'verification',
            p0: 0,
            p1: 0,
            scope: 'Pre-delivery bookkeeping',
        });
        transitionState(current, 'delivery');
        recordReviewDecision(current, {
            freeze: true,
            headSha: 'delivery-head',
            mode: 'verification',
            p0: 0,
            p1: 0,
            scope: 'Delivery repair',
        });
        transitionState(current, 'deep_review');
        current.reviewGate.rounds.push({
            ...current.reviewGate.rounds[1],
            headSha: 'returned-deep-review-head',
            scope: 'Legacy returned deep-review repair',
        });
        current.reviewGate.frozenHeadSha = 'returned-deep-review-head';
        current.events = [
            { at: '1', detail: 'issue_execution -> deep_review', type: 'phase' },
            {
                at: '2',
                detail: 'full review for product-head: P0=0 P1=0 (frozen)',
                type: 'review',
            },
            {
                at: '3',
                detail: 'verification review for pre-delivery-head: P0=0 P1=0 (frozen)',
                type: 'review',
            },
            { at: '4', detail: 'deep_review -> delivery', type: 'phase' },
            {
                at: '5',
                detail: 'verification review for delivery-head: P0=0 P1=0 (frozen)',
                type: 'review',
            },
            { at: '6', detail: 'delivery -> deep_review', type: 'phase' },
            {
                at: '7',
                detail: 'verification review for returned-deep-review-head: P0=0 P1=0 (frozen)',
                type: 'review',
            },
        ];
        for (const decision of current.reviewGate.rounds) {
            Reflect.deleteProperty(decision, 'phase');
        }

        const migrated = validateState({ ...current, schemaVersion: 4 });
        expect(migrated.reviewGate.rounds.map(({ phase }) => phase)).toEqual([
            'deep_review',
            'deep_review',
            'delivery',
            'deep_review',
        ]);
        expect(() =>
            recordReviewDecision(migrated, {
                freeze: true,
                headSha: 'another-deep-review-head',
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Excess returned deep-review repair',
            }),
        ).toThrow('one pre-delivery');
    });

    it('charges v4 reviews with missing review events to both phase budgets', () => {
        const current = createInitialState({
            objective: 'Migrate truncated review evidence',
            runId: 'legacy-v4-truncated',
        });
        transitionState(current, 'planning');
        transitionState(current, 'issue_execution');
        transitionState(current, 'deep_review');
        freezeReview(current, 'product-head');
        recordReviewDecision(current, {
            freeze: true,
            headSha: 'verification-1',
            mode: 'verification',
            p0: 0,
            p1: 0,
            scope: 'Legacy verification',
        });
        transitionState(current, 'delivery');
        for (const headSha of ['verification-2', 'verification-3']) {
            recordReviewDecision(current, {
                freeze: true,
                headSha,
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Legacy verification',
            });
        }
        for (const decision of current.reviewGate.rounds) {
            Reflect.deleteProperty(decision, 'phase');
        }
        const migrated = validateState({ ...current, schemaVersion: 4 });
        expect(
            migrated.reviewGate.rounds
                .filter(({ mode }) => mode === 'verification')
                .map(({ phase }) => phase),
        ).toEqual(['unknown', 'unknown', 'unknown']);
        expect(() =>
            recordReviewDecision(migrated, {
                freeze: true,
                headSha: 'delivery-4',
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Excess delivery repair',
            }),
        ).toThrow('requires explicit user authorization');

        transitionState(migrated, 'deep_review');
        expect(() =>
            recordReviewDecision(migrated, {
                freeze: true,
                headSha: 'deep-review-2',
                mode: 'verification',
                p0: 0,
                p1: 0,
                scope: 'Excess pre-delivery repair',
            }),
        ).toThrow('one pre-delivery');
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
