import { spawn } from 'node:child_process';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createResumeCheckpoint } from './resume';
import { recordPublishedAcceptance } from './acceptance-publication';
import { assessExpectationDrift } from './issue-drift';
import { recordReviewDecision } from './review-gate';
import {
    addEvent,
    createInitialState,
    recordAcceptance,
    recordNote,
    recordPullRequest,
    recordWorktree,
    transitionState,
    upsertIssue,
    validateState,
} from './state';
import {
    prepareRunDirectory,
    readState,
    resolveStatePath,
    statePathForRunId,
    writeInitialState,
    writeState,
    withStateLock,
} from './state-storage';

const REQUIRED_SECTIONS = [
    'delivery',
    'review',
    'technical-debt',
    'workflow',
    'cost',
    'automation',
    'boundaries',
] as const;

function freezeReview(state: ReturnType<typeof createInitialState>, headSha: string) {
    recordReviewDecision(state, {
        freeze: true,
        headSha,
        mode: 'full',
        p0: 0,
        p1: 0,
        reviewedRange: `origin/main...${headSha}`,
        scope: 'Goal range',
    });
}

function readyDelivery(headSha = 'head-1') {
    const state = createInitialState({ objective: 'Test Go delivery', runId: 'state-test' });
    transitionState(state, 'planning');
    transitionState(state, 'issue_execution');
    upsertIssue(state, { number: 111, status: 'progressing', title: 'Improve Go' });
    assessExpectationDrift(state, {
        driftKey: 'final-assessment',
        headSha,
        issueNumber: 111,
        kind: 'internal_detail',
    });
    upsertIssue(state, { commits: [headSha], number: 111, status: 'complete' });
    transitionState(state, 'deep_review');
    freezeReview(state, headSha);
    transitionState(state, 'delivery');
    recordPullRequest(state, {
        headSha,
        number: 120,
        status: 'ready',
        url: 'https://github.com/tjx666/caxri/pull/120',
    });
    return state;
}

function attachReport(
    state: ReturnType<typeof createInitialState>,
    options: { delivered?: boolean; headSha?: string } = {},
) {
    state.handoffReport = {
        deliveredAt: options.delivered ? '2026-08-12T01:00:00.000Z' : null,
        evidence: {
            actionsUse: 'remote=ready; localFallback=not_requested',
            commitFileMetrics: 'unavailable',
            costCheckpointCount: state.runBudget.checkpoints.length || 1,
            issueDriftAssessmentCount: 1,
            issueDriftCommentCount: 0,
            reviewBaselineId: 'review-001',
            reviewDecisionCount: 1,
            reviewLineageComplete: true,
            reviewPolicyMode: 'full-once',
            validationRepairCount: 0,
        },
        generatedAt: '2026-08-12T00:59:00.000Z',
        headSha: options.headSha ?? state.pullRequest.headSha!,
        path: 'handoff-report.md',
        sections: [...REQUIRED_SECTIONS],
        sha256: '0'.repeat(64),
    };
}

function publishRound(
    state: ReturnType<typeof createInitialState>,
    roundIndex: number,
    headSha = 'head-1',
) {
    recordPublishedAcceptance(state, {
        acceptanceId: 'acc-1',
        checkIds: ['issue-111-go-state'],
        headSha,
        publishedAt: `2026-08-12T00:0${roundIndex}:00.000Z`,
        roundIndex,
        url: 'https://app.lobehub.com/acceptance/acc-1',
        verdict: 'pass',
        verifyRunId: `run-${roundIndex}`,
    });
}

describe('Go state ledger', () => {
    it('rejects path-like run IDs before resolving the ledger path', () => {
        expect(() => statePathForRunId('../../../../tmp/untrusted-run')).toThrow(
            'Go run ID must be a single path segment',
        );
        expect(statePathForRunId('valid-run')).toMatch(/\.records\/go\/valid-run\/state\.json$/);
    });

    it('creates the stable run directory layout without session transcripts', async () => {
        const runId = `layout-${Date.now()}-${process.pid}`;
        const statePath = statePathForRunId(runId);
        const runDirectory = dirname(statePath);
        try {
            await prepareRunDirectory(statePath);
            expect((await readdir(runDirectory)).sort()).toEqual([
                'acceptance',
                'artifacts',
                'ci-artifacts',
                'reviews',
                'validation',
            ]);
        } finally {
            await rm(runDirectory, { force: true, recursive: true });
        }
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

    it('rejects an existing run directory symlinked to another internal ledger', async () => {
        const suffix = `${Date.now()}-${process.pid}`;
        const targetPath = statePathForRunId(`internal-target-${suffix}`);
        const linkedPath = statePathForRunId(`internal-link-${suffix}`);
        const targetDirectory = dirname(targetPath);
        const linkedDirectory = dirname(linkedPath);
        try {
            await prepareRunDirectory(targetPath);
            await writeInitialState(
                targetPath,
                createInitialState({
                    objective: 'Target ledger',
                    runId: `internal-target-${suffix}`,
                }),
            );
            await symlink(targetDirectory, linkedDirectory, 'dir');

            await expect(resolveStatePath(linkedPath)).rejects.toThrow(
                'state parent must be a direct directory',
            );
        } finally {
            await rm(linkedDirectory, { force: true });
            await rm(targetDirectory, { force: true, recursive: true });
        }
    });

    it('pins one isolated worktree and resumes that same path', () => {
        const state = createInitialState({ objective: 'Isolate Go', runId: 'worktree-test' });
        recordWorktree(
            state,
            {
                baseSha: 'base-1',
                branch: 'codex/go-test',
                mainCheckoutPath: '/repo',
                path: '/repo-worktrees/go-test',
            },
            '2026-08-12T00:00:00.000Z',
        );
        recordWorktree(state, {
            baseSha: 'base-1',
            branch: 'codex/go-test',
            mainCheckoutPath: '/repo',
            path: '/repo-worktrees/go-test',
        });

        expect(createResumeCheckpoint(state).worktree).toMatchObject({
            baseSha: 'base-1',
            path: '/repo-worktrees/go-test',
        });
        expect(state.branch).toBe('codex/go-test');
        expect(() =>
            recordWorktree(state, {
                baseSha: 'base-2',
                mainCheckoutPath: '/repo',
                path: '/repo-worktrees/other',
            }),
        ).toThrow('cannot switch to a different worktree');
    });

    it('records one cost checkpoint when each phase ends', () => {
        const state = createInitialState({ objective: 'Track phases', runId: 'phase-test' });
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');

        expect(state.runBudget.checkpoints.map(({ phase }) => phase)).toEqual([
            'intake',
            'planning',
        ]);
        expect(state.runBudget.checkpoints[0]).toMatchObject({
            elapsedSeconds: 'unavailable',
            tokens: 'unavailable',
        });
    });

    it('requires a review-clean head and completed issues before delivery', () => {
        const state = createInitialState({ objective: 'Protect delivery', runId: 'delivery-test' });
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        upsertIssue(state, { number: 111, status: 'progressing', title: 'Improve Go' });
        transitionState(state, 'deep_review');

        expect(() => validateState(state)).toThrow('unfinished issues #111');
        assessExpectationDrift(state, {
            driftKey: 'final-assessment',
            headSha: 'head-1',
            issueNumber: 111,
            kind: 'internal_detail',
        });
        upsertIssue(state, { commits: ['head-1'], number: 111, status: 'complete' });
        expect(() => transitionState(state, 'delivery')).toThrow(
            'explicitly frozen review-clean head',
        );
        freezeReview(state, 'head-1');
        expect(() => transitionState(state, 'delivery')).not.toThrow();
    });

    it('fails closed before waiting when the exact-head report is absent or undelivered', () => {
        const state = readyDelivery();
        transitionState(state, 'acceptance');
        publishRound(state, 1);
        transitionState(state, 'acceptance_handoff');

        expect(createResumeCheckpoint(state).nextAction).toBe(
            'Generate the exact-head handoff report',
        );
        expect(() => transitionState(state, 'waiting_acceptance')).toThrow(
            'generated handoff report',
        );
        attachReport(state);
        expect(() => transitionState(state, 'waiting_acceptance')).toThrow(
            'has not been delivered',
        );
        attachReport(state, { delivered: true, headSha: 'stale-head' });
        expect(() => transitionState(state, 'waiting_acceptance')).toThrow(
            'does not match the exact head',
        );
        attachReport(state, { delivered: true });
        expect(() => transitionState(state, 'waiting_acceptance')).not.toThrow();
    });

    it('rejects pending Acceptance state without verified publication lineage', () => {
        const state = readyDelivery();
        transitionState(state, 'acceptance');
        recordAcceptance(state, {
            id: 'acc-unverified',
            round: 1,
            status: 'pending',
            url: 'https://app.lobehub.com/acceptance/acc-unverified',
        });

        expect(() => validateState(state)).toThrow('no verified publication lineage');
        expect(() => transitionState(state, 'acceptance_handoff')).toThrow(
            'no verified publication lineage',
        );
    });

    it('restores rejected Acceptance and merges only the accepted exact head', () => {
        const state = readyDelivery();
        transitionState(state, 'acceptance');
        publishRound(state, 1);
        transitionState(state, 'acceptance_handoff');
        attachReport(state, { delivered: true });
        transitionState(state, 'waiting_acceptance');
        recordAcceptance(state, { status: 'rejected' });
        transitionState(state, 'acceptance');

        publishRound(state, 2);
        transitionState(state, 'acceptance_handoff');
        attachReport(state, { delivered: true });
        transitionState(state, 'waiting_acceptance');
        recordAcceptance(state, { acceptedHeadSha: 'head-1', status: 'accepted' });
        expect(() => transitionState(state, 'merge')).not.toThrow();
    });

    it('supports an explicit non-product Acceptance waiver without weakening final reporting', () => {
        const state = readyDelivery();
        recordAcceptance(state, {
            status: 'waived',
            waivedHeadSha: 'head-1',
            waiverReason: 'User explicitly waived desktop Acceptance for skill-only changes.',
        });
        transitionState(state, 'acceptance_handoff');

        expect(() => transitionState(state, 'merge')).toThrow('generated handoff report');
        attachReport(state);
        expect(() => transitionState(state, 'merge')).not.toThrow();
    });

    it('blocks Acceptance handoff when drift is detected after PR readiness', () => {
        const state = readyDelivery();
        recordAcceptance(state, {
            status: 'waived',
            waivedHeadSha: 'head-1',
            waiverReason: 'No product or UI behavior changed.',
        });
        assessExpectationDrift(state, {
            acceptanceImpact: '原验证计划需要增加一条稳定检查。',
            decision: '保留冻结范围，并在继续交付前记录实现决定。',
            driftKey: 'late-discovery',
            evidence: 'PR ready 后发现原架构假设不完整。',
            expectation: '原预期认为现有状态门禁已经覆盖所有恢复路径。',
            headSha: 'head-1',
            issueNumber: 111,
            kind: 'partial_root_cause',
        });

        expect(() => transitionState(state, 'acceptance_handoff')).toThrow('without a comment');
    });

    it('cannot complete without delivered handoff and finalization receipts', () => {
        const state = readyDelivery();
        recordAcceptance(state, {
            status: 'waived',
            waivedHeadSha: 'head-1',
            waiverReason: 'No product or UI behavior changed.',
        });
        transitionState(state, 'acceptance_handoff');
        attachReport(state);
        transitionState(state, 'merge');
        recordPullRequest(state, { status: 'merged' });
        transitionState(state, 'finalization');

        expect(() => transitionState(state, 'complete')).toThrow('delivered handoff report');
        attachReport(state, { delivered: true });
        expect(() => transitionState(state, 'complete')).toThrow('delivered finalization receipt');
        state.finalization = {
            deliveredAt: '2026-08-12T02:00:00.000Z',
            headSha: 'head-1',
            issues: [{ number: 111, projectStatus: 'Done', state: 'CLOSED' }],
            mergeSha: 'merge-1',
            path: 'finalization.json',
            pullRequestNumber: 120,
            verifiedAt: '2026-08-12T01:59:00.000Z',
        };
        expect(() => transitionState(state, 'complete')).not.toThrow();
    });

    it('migrates pre-v6 review and Acceptance lineage without losing evidence', () => {
        const current = createInitialState({ objective: 'Migrate ledger', runId: 'legacy-v5' });
        const legacy = {
            ...current,
            acceptance: {
                acceptedHeadSha: null,
                id: 'acc-legacy',
                round: 1,
                status: 'pending',
                url: 'https://app.lobehub.com/acceptance/acc-legacy',
            },
            phase: 'waiting_acceptance',
            pullRequest: {
                headSha: 'legacy-repair',
                number: 109,
                status: 'ready',
                url: 'https://github.com/tjx666/caxri/pull/109',
            },
            reviewGate: {
                frozenHeadSha: 'legacy-repair',
                rounds: [
                    {
                        completedAt: '2026-08-11T00:00:00.000Z',
                        headSha: 'legacy-base',
                        mode: 'full',
                        phase: 'deep_review',
                        productP0: 0,
                        productP1: 0,
                        scope: 'Legacy Goal review',
                    },
                    {
                        completedAt: '2026-08-11T00:10:00.000Z',
                        headSha: 'legacy-repair',
                        mode: 'targeted',
                        phase: 'delivery',
                        productP0: 0,
                        productP1: 0,
                        scope: 'Legacy repair',
                    },
                    {
                        completedAt: '2026-08-11T00:20:00.000Z',
                        headSha: 'legacy-repair',
                        mode: 'verification',
                        phase: 'delivery',
                        productP0: 0,
                        productP1: 0,
                        scope: 'Legacy evidence check',
                    },
                ],
            },
            schemaVersion: 5,
            status: 'waiting_acceptance',
        } as Record<string, unknown>;
        for (const key of [
            'finalization',
            'handoffReport',
            'reviewPolicy',
            'runBudget',
            'validations',
            'worktree',
        ]) {
            Reflect.deleteProperty(legacy, key);
        }

        const migrated = validateState(legacy);
        expect(migrated).toMatchObject({
            acceptance: {
                id: 'acc-legacy',
                publication: {
                    history: [
                        {
                            acceptanceId: 'acc-legacy',
                            headSha: 'legacy-repair',
                            roundIndex: 1,
                            verifyRunId: 'legacy-unavailable',
                        },
                    ],
                },
                waivedHeadSha: null,
            },
            handoffReport: null,
            phase: 'acceptance_handoff',
            schemaVersion: 9,
        });
        expect(
            migrated.reviewGate.rounds.map(({ legacyMode, mode }) => ({ legacyMode, mode })),
        ).toEqual([
            { legacyMode: null, mode: 'full' },
            { legacyMode: 'targeted', mode: 'light' },
        ]);
        expect(migrated.validations).toHaveLength(1);
        expect(createResumeCheckpoint(migrated).nextAction).toBe(
            'Generate the exact-head handoff report',
        );
    });

    it('normalizes additional historical full reviews into an auditable light lineage', () => {
        const current = createInitialState({ objective: 'Migrate reviews', runId: 'legacy-fulls' });
        const legacy = {
            ...current,
            reviewGate: {
                frozenHeadSha: 'legacy-repair',
                rounds: [
                    {
                        completedAt: '2026-08-11T00:00:00.000Z',
                        headSha: 'legacy-base',
                        mode: 'full',
                        phase: 'deep_review',
                        productP0: 0,
                        productP1: 0,
                        scope: 'First legacy full review',
                    },
                    {
                        completedAt: '2026-08-11T00:10:00.000Z',
                        headSha: 'legacy-repair',
                        mode: 'full',
                        phase: 'delivery',
                        productP0: 0,
                        productP1: 0,
                        scope: 'Second legacy full review',
                    },
                ],
            },
            schemaVersion: 5,
        } as Record<string, unknown>;
        for (const key of [
            'finalization',
            'handoffReport',
            'reviewPolicy',
            'runBudget',
            'validations',
            'worktree',
        ]) {
            Reflect.deleteProperty(legacy, key);
        }

        const migrated = validateState(legacy);
        expect(
            migrated.reviewGate.rounds.map(({ legacyMode, mode, reviewedRange }) => ({
                legacyMode,
                mode,
                reviewedRange,
            })),
        ).toEqual([
            {
                legacyMode: null,
                mode: 'full',
                reviewedRange: 'legacy:First legacy full review',
            },
            {
                legacyMode: 'full',
                mode: 'light',
                reviewedRange: 'legacy-base..legacy-repair',
            },
        ]);
    });

    it('migrates schema version 2 ledgers through the current schema', () => {
        const current = createInitialState({ objective: 'Resume old ledger', runId: 'legacy-v2' });
        const legacy = { ...current, schemaVersion: 2 } as Record<string, unknown>;
        for (const key of [
            'ciFallback',
            'finalization',
            'handoffReport',
            'reviewGate',
            'reviewPolicy',
            'runBudget',
            'validationBudget',
            'validations',
            'worktree',
        ]) {
            Reflect.deleteProperty(legacy, key);
        }

        expect(validateState(legacy)).toMatchObject({
            ciFallback: { status: 'not_requested' },
            schemaVersion: 9,
            validationBudget: { fullElectronE2eRuns: [] },
        });
    });

    it('requires resumed v6 work to assess drift while preserving completed history', () => {
        const current = createInitialState({ objective: 'Resume v6 ledger', runId: 'legacy-v6' });
        upsertIssue(current, { number: 113, status: 'progressing', title: 'Track drift' });
        upsertIssue(current, { number: 112, status: 'progressing', title: 'Preserve history' });
        current.issues[1].commits.push('legacy-head');
        current.issues[1].status = 'complete';
        const legacy = { ...current, schemaVersion: 6 } as Record<string, unknown>;
        legacy.issues = current.issues.map((issue) => {
            const legacyIssue: Record<string, unknown> = { ...issue };
            delete legacyIssue.expectationDrift;
            return legacyIssue;
        });

        const resumed = validateState(legacy);
        expect(resumed.issues[0].expectationDrift).toEqual({
            assessedAt: null,
            assessmentHeadSha: null,
            records: [],
            status: 'none',
        });
        expect(resumed.issues[1].expectationDrift.assessedAt).toBe('legacy-unavailable');
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

    it('fails closed when another process owns the state writer lock', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-go-lock-'));
        const path = join(directory, 'state.json');
        const state = createInitialState({ objective: 'Serialize writers', runId: 'writer-lock' });
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const acquired = new Promise<void>((resolve) => (entered = resolve));
        try {
            await writeInitialState(path, state);
            const owner = withStateLock(path, async () => {
                entered();
                await held;
            });
            await acquired;

            await expect(withStateLock(path, () => Promise.resolve())).rejects.toThrow(
                'already locked by another writer',
            );
            release();
            await owner;
            await expect(access(join(directory, 'state.lock'))).rejects.toThrow();
        } finally {
            release?.();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('bounds and redacts structured notes before persistence', () => {
        const state = createInitialState({ objective: 'Protect notes', runId: 'safe-notes' });
        recordNote(state, {
            kind: 'technical_debt',
            text: 'Remote probe failed with token=private-value',
        });

        expect(state.notes.technical_debt[0]).toMatchObject({
            kind: 'technical_debt',
            redacted: true,
            text: 'Remote probe failed with token=[REDACTED]',
        });
        expect(() => recordNote(state, { kind: 'workflow', text: 'x'.repeat(4_097) })).toThrow(
            'Note text exceeds 4096 characters',
        );
    });

    it('archives overflow history with a count and digest while keeping state bounded', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-go-retention-'));
        const path = join(directory, 'state.json');
        const state = createInitialState({ objective: 'Bound history', runId: 'retention' });
        try {
            await mkdir(join(directory, 'artifacts'));
            await writeInitialState(path, state);
            for (let index = 0; index < 160; index += 1) {
                addEvent(state, 'phase', `phase transition ${index}`);
            }
            for (let index = 0; index < 35; index += 1) {
                recordNote(state, {
                    kind: 'workflow',
                    text: `流程观察 ${index}${index === 0 ? ' token=private-history-value' : ''}`,
                });
            }

            await writeState(path, state);
            const persisted = await readState(path);
            expect(persisted.events.length).toBeLessThanOrEqual(120);
            expect(persisted.notes.workflow.length).toBeLessThanOrEqual(20);
            const archive = persisted.retention.archive!;
            expect(archive.byteLength).toBeGreaterThan(0);
            expect(archive.counts.events).toBeGreaterThan(0);
            expect(archive.counts['notes.workflow']).toBeGreaterThan(0);
            expect(archive.path).toMatch(/^artifacts\/ledger-history-[0-9a-f]{64}\.json$/u);
            expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/u);
            expect(archive.entryCount).toBeGreaterThan(0);
            const archiveSource = await readFile(join(directory, archive.path), 'utf8');
            expect(archiveSource).toContain('流程观察 0 token=[REDACTED]');
            expect(archiveSource).not.toContain('private-history-value');
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('does not duplicate overflow when a state replacement is retried', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-go-retention-retry-'));
        const path = join(directory, 'state.json');
        const state = createInitialState({ objective: 'Retry history', runId: 'retention-retry' });
        try {
            await mkdir(join(directory, 'artifacts'));
            await writeInitialState(path, state);
            for (let index = 0; index < 25; index += 1) {
                recordNote(state, { kind: 'workflow', text: `重试观察 ${index}` });
            }
            await writeState(path, state);
            const persisted = await readState(path);
            const firstCount = persisted.retention.archive!.entryCount;
            const archiveSource = JSON.parse(
                await readFile(join(directory, persisted.retention.archive!.path), 'utf8'),
            ) as { entries: Array<{ value: (typeof persisted.notes.workflow)[number] }> };
            persisted.notes.workflow.unshift(
                ...archiveSource.entries.slice(0, 5).map(({ value }) => value),
            );

            await writeState(path, persisted);
            expect((await readState(path)).retention.archive!.entryCount).toBe(firstCount);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('does not follow a replaced run directory while updating state', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-go-path-race-'));
        const runDirectory = join(root, 'run');
        const savedDirectory = join(root, 'saved-run');
        const outsideDirectory = join(root, 'outside');
        const path = join(runDirectory, 'state.json');
        const outsidePath = join(outsideDirectory, 'state.json');
        const state = createInitialState({ objective: 'Reject path race', runId: 'path-race' });
        try {
            await mkdir(runDirectory);
            await mkdir(outsideDirectory);
            await writeInitialState(path, state);
            await writeFile(outsidePath, 'outside sentinel', 'utf8');
            await rename(runDirectory, savedDirectory);
            await symlink(outsideDirectory, runDirectory, 'dir');

            await expect(writeState(path, state)).rejects.toThrow('direct directory');
            expect(await readFile(outsidePath, 'utf8')).toBe('outside sentinel');
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it('uses an unpredictable exclusive temporary file for state replacement', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-go-temp-race-'));
        const outsidePath = join(directory, 'outside.txt');
        const path = join(directory, 'state.json');
        const state = createInitialState({ objective: 'Protect temp files', runId: 'temp-race' });
        try {
            await writeInitialState(path, state);
            await writeFile(outsidePath, 'outside sentinel', 'utf8');
            await symlink(outsidePath, `${path}.${process.pid}.tmp`);
            state.objective = 'Updated safely';

            await writeState(path, state);
            expect(await readFile(outsidePath, 'utf8')).toBe('outside sentinel');
            expect((await readState(path)).objective).toBe('Updated safely');
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});
