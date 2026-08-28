import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { validateHumanText } from '../../acceptance/scripts/validate-report';
import {
    acceptancePublicationSchema,
    assertPublishedAcceptanceLineage,
    createEmptyAcceptancePublication,
    recordOrphanedAcceptance,
} from './acceptance-publication';
import {
    assertDeliveryCanAdvance,
    ciFallbackSchema,
    createEmptyCiFallback,
    createEmptyValidationBudget,
    validationBudgetSchema,
} from './ci-fallback';
import { assertFinalizationComplete, finalizationSchema } from './finalization';
import { assertHandoffReady, handoffReportSchema } from './handoff-report';
import {
    assertIssueExpectationDriftReady,
    createEmptyIssueExpectationDrift,
    issueExpectationDriftSchema,
} from './issue-drift';
import { createEmptyLedgerRetention, ledgerRetentionSchema } from './ledger-retention';
import { mutationLeaseSchema } from './mutation-lease';
import { MAX_NOTE_TEXT_CHARACTERS, sanitizeLedgerDetail, sanitizeNoteText } from './note-safety';
import {
    assertReviewHeadFrozen,
    createEmptyReviewGate,
    createReviewPolicy,
    reviewGateSchema,
    reviewPolicySchema,
} from './review-gate';
import {
    createRunBudget,
    ensurePhaseCheckpoint,
    freezeRunBudgetPolicy,
    recordCostCheckpoint,
    runBudgetSchema,
} from './run-budget';
import { migrateState } from './state-migration';
import { validationsSchema } from './validation-gate';

const SCHEMA_VERSION = 10;

const PHASES = [
    'intake',
    'planning',
    'issue_execution',
    'deep_review',
    'delivery',
    'acceptance',
    'acceptance_handoff',
    'waiting_acceptance',
    'merge',
    'finalization',
    'complete',
] as const;
const ISSUE_STATUSES = [
    'queued',
    'progressing',
    'reviewing',
    'committed',
    'complete',
    'deferred',
] as const;
const PR_STATUSES = [
    'none',
    'draft',
    'open',
    'checks_pending',
    'checks_blocked',
    'ready',
    'merged',
    'closed',
] as const;
const ACCEPTANCE_STATUSES = [
    'not_started',
    'running',
    'failed',
    'blocked',
    'pending',
    'rejected',
    'accepted',
    'waived',
] as const;
const NOTE_KINDS = ['technical_debt', 'workflow', 'token_waste'] as const;

export const phaseSchema = z.enum(PHASES);
export const issueStatusSchema = z.enum(ISSUE_STATUSES);
export const pullRequestStatusSchema = z.enum(PR_STATUSES);
export const acceptanceStatusSchema = z.enum(ACCEPTANCE_STATUSES);
export const noteKindSchema = z.enum(NOTE_KINDS);

export type Phase = z.infer<typeof phaseSchema>;
type IssueStatus = z.infer<typeof issueStatusSchema>;
type PullRequestStatus = z.infer<typeof pullRequestStatusSchema>;
type AcceptanceStatus = z.infer<typeof acceptanceStatusSchema>;
export type NoteKind = z.infer<typeof noteKindSchema>;

const eventSchema = z.object({
    at: z.string(),
    detail: z.string().max(MAX_NOTE_TEXT_CHARACTERS),
    type: z.string(),
});
const noteSchema = z.object({
    at: z.string(),
    kind: noteKindSchema,
    redacted: z.boolean(),
    text: z.string().min(1).max(MAX_NOTE_TEXT_CHARACTERS),
    truncated: z.boolean(),
});
const issueSchema = z.object({
    acceptanceCheckIds: z.array(z.string()),
    commits: z.array(z.string()),
    dependencies: z.array(z.number().int().positive()),
    expectationDrift: issueExpectationDriftSchema,
    number: z.number().int().positive(),
    priority: z.string().nullable(),
    status: issueStatusSchema,
    title: z.string(),
    validations: z.array(z.string()),
});
const worktreeSchema = z.object({
    baseSha: z.string().min(1),
    createdAt: z.string(),
    mainCheckoutPath: z.string().min(1),
    path: z.string().min(1),
});

const goStateSchema = z.object({
    acceptance: z.object({
        acceptedHeadSha: z.string().nullable(),
        id: z.string().nullable(),
        publication: acceptancePublicationSchema,
        round: z.number().int().nonnegative(),
        status: acceptanceStatusSchema,
        url: z.string().nullable(),
        waivedHeadSha: z.string().nullable(),
        waiverReason: z.string().nullable(),
    }),
    branch: z.string().nullable(),
    ciFallback: ciFallbackSchema,
    createdAt: z.string(),
    events: z.array(eventSchema),
    finalization: finalizationSchema.nullable(),
    handoffReport: handoffReportSchema.nullable(),
    issues: z.array(issueSchema),
    mutationLease: mutationLeaseSchema,
    notes: z.object({
        technical_debt: z.array(noteSchema),
        token_waste: z.array(noteSchema),
        workflow: z.array(noteSchema),
    }),
    objective: z.string().min(1),
    phase: phaseSchema,
    pullRequest: z.object({
        headSha: z.string().nullable(),
        number: z.number().int().positive().nullable(),
        status: pullRequestStatusSchema,
        url: z.string().nullable(),
    }),
    retention: ledgerRetentionSchema,
    reviewGate: reviewGateSchema,
    reviewPolicy: reviewPolicySchema,
    runBudget: runBudgetSchema,
    runId: z.string().min(1),
    schemaVersion: z.literal(SCHEMA_VERSION),
    status: z.enum(['planning', 'active', 'waiting_acceptance', 'complete']),
    updatedAt: z.string(),
    validationBudget: validationBudgetSchema,
    validations: validationsSchema,
    worktree: worktreeSchema.nullable(),
});

export type GoState = z.infer<typeof goStateSchema>;

export interface IssueInput {
    checks?: string[];
    commits?: string[];
    dependencies?: number[];
    number: number;
    priority?: string;
    status?: IssueStatus;
    title?: string;
    validations?: string[];
}

export interface PullRequestInput {
    branch?: string;
    headSha?: string;
    number?: number;
    status?: PullRequestStatus;
    url?: string;
}

export interface AcceptanceInput {
    acceptedHeadSha?: string;
    id?: string;
    status?: AcceptanceStatus;
    url?: string;
    waivedHeadSha?: string;
    waiverReason?: string;
}

export interface WorktreeInput {
    baseSha: string;
    branch?: string;
    mainCheckoutPath: string;
    path: string;
}

const PHASE_TRANSITIONS: Record<Phase, ReadonlySet<Phase>> = {
    acceptance: new Set(['acceptance', 'acceptance_handoff', 'deep_review', 'issue_execution']),
    acceptance_handoff: new Set([
        'acceptance',
        'acceptance_handoff',
        'deep_review',
        'merge',
        'waiting_acceptance',
    ]),
    complete: new Set(),
    deep_review: new Set(['deep_review', 'delivery', 'issue_execution']),
    delivery: new Set(['acceptance', 'acceptance_handoff', 'deep_review', 'delivery']),
    finalization: new Set(['complete', 'finalization']),
    intake: new Set(['planning']),
    issue_execution: new Set(['deep_review', 'issue_execution']),
    merge: new Set(['deep_review', 'finalization', 'merge']),
    planning: new Set(['intake', 'issue_execution']),
    waiting_acceptance: new Set(['acceptance', 'merge', 'waiting_acceptance']),
};

export function now(): string {
    return new Date().toISOString();
}

function statusForPhase(phase: Phase): GoState['status'] {
    if (phase === 'complete') return 'complete';
    if (phase === 'waiting_acceptance') return 'waiting_acceptance';
    if (phase === 'intake' || phase === 'planning') return 'planning';
    return 'active';
}

export function addEvent(state: GoState, type: string, detail: string): void {
    state.events.push({ at: now(), detail: sanitizeLedgerDetail(detail), type });
}

function uniqueAppend<T>(target: T[], values: T[]): void {
    for (const value of values) if (!target.includes(value)) target.push(value);
}

export function createInitialState({
    branch = null,
    objective,
    runId,
    worktree = null,
}: {
    branch?: string | null;
    objective: string;
    runId: string;
    worktree?: GoState['worktree'];
}): GoState {
    const timestamp = now();
    return {
        acceptance: {
            acceptedHeadSha: null,
            id: null,
            publication: createEmptyAcceptancePublication(),
            round: 0,
            status: 'not_started',
            url: null,
            waivedHeadSha: null,
            waiverReason: null,
        },
        branch,
        ciFallback: createEmptyCiFallback(),
        createdAt: timestamp,
        events: [{ at: timestamp, detail: 'Run ledger initialized', type: 'init' }],
        finalization: null,
        handoffReport: null,
        issues: [],
        mutationLease: null,
        notes: { technical_debt: [], token_waste: [], workflow: [] },
        objective,
        phase: 'intake',
        pullRequest: { headSha: null, number: null, status: 'none', url: null },
        retention: createEmptyLedgerRetention(),
        reviewGate: createEmptyReviewGate(),
        reviewPolicy: createReviewPolicy(),
        runBudget: createRunBudget(),
        runId,
        schemaVersion: SCHEMA_VERSION,
        status: 'planning',
        updatedAt: timestamp,
        validationBudget: createEmptyValidationBudget(),
        validations: [],
        worktree,
    };
}

function decisionHead(state: GoState): string | null {
    return state.acceptance.status === 'waived'
        ? state.acceptance.waivedHeadSha
        : state.acceptance.acceptedHeadSha;
}

function assertAllIssueExpectationDriftReady(state: GoState, expectedHeadSha: string): void {
    for (const issue of state.issues) {
        if (issue.status === 'deferred') continue;
        assertIssueExpectationDriftReady(issue, expectedHeadSha);
    }
}

export function transitionState(state: GoState, phase: Phase, reason = ''): GoState {
    const allowed = PHASE_TRANSITIONS[state.phase];
    if (!allowed.has(phase))
        throw new Error(`Invalid phase transition: ${state.phase} -> ${phase}`);
    ensurePhaseCheckpoint(state);
    if (phase === 'planning' && state.phase === 'intake') freezeRunBudgetPolicy(state);
    if (phase === 'deep_review' && state.phase === 'issue_execution') {
        recordCostCheckpoint(state, { boundary: 'batch' });
    }
    if (phase === 'delivery' && state.phase === 'deep_review') assertReviewHeadFrozen(state);
    if (state.phase === 'delivery' && ['acceptance', 'acceptance_handoff'].includes(phase)) {
        const headSha = state.pullRequest.headSha;
        if (!headSha) throw new Error('Acceptance requires the exact pull request head');
        assertAllIssueExpectationDriftReady(state, headSha);
        assertReviewHeadFrozen(state, headSha);
        assertDeliveryCanAdvance(state);
        if (phase === 'acceptance_handoff' && state.acceptance.status !== 'waived') {
            throw new Error('Only an explicit Acceptance waiver can skip directly to handoff');
        }
    }
    if (phase === 'acceptance_handoff' && state.phase === 'acceptance') {
        if (
            state.acceptance.status !== 'pending' ||
            !state.acceptance.id ||
            !state.acceptance.url ||
            state.acceptance.round < 1
        ) {
            throw new Error('Acceptance handoff requires a published pending Acceptance round');
        }
        assertPublishedAcceptanceLineage(state, state.pullRequest.headSha ?? undefined);
    }
    if (phase === 'waiting_acceptance' && state.phase === 'acceptance_handoff') {
        if (state.acceptance.status !== 'pending') {
            throw new Error('Waiting Acceptance requires a pending human decision');
        }
        assertHandoffReady(state, state.pullRequest.headSha ?? '');
    }
    if (phase === 'merge') {
        const headSha = state.pullRequest.headSha;
        if (!headSha || decisionHead(state) !== headSha) {
            throw new Error('Merge requires the exact accepted or explicitly waived PR head');
        }
        if (state.acceptance.status === 'waived') assertHandoffReady(state, headSha, false);
        else assertPublishedAcceptanceLineage(state, headSha);
    }
    if (
        phase === 'finalization' &&
        state.phase === 'merge' &&
        state.pullRequest.status !== 'merged'
    ) {
        throw new Error('Finalization requires a remotely merged pull request');
    }
    if (phase === 'complete' && state.phase === 'finalization') {
        assertFinalizationComplete(state);
    }

    const previous = state.phase;
    state.phase = phase;
    state.status = statusForPhase(phase);
    addEvent(state, 'phase', `${previous} -> ${phase}${reason ? `: ${reason}` : ''}`);
    return state;
}

export function upsertIssue(state: GoState, input: IssueInput): GoState {
    if (!Number.isSafeInteger(input.number) || input.number <= 0) {
        throw new Error('Issue number must be positive');
    }
    if ((input.dependencies ?? []).some((number) => !Number.isSafeInteger(number) || number <= 0)) {
        throw new Error('Issue dependencies must be positive integers');
    }
    let issue = state.issues.find((item) => item.number === input.number);
    const wasComplete = issue?.status === 'complete';
    if (!issue) {
        if (!input.title) throw new Error('A new issue requires --title');
        issue = {
            acceptanceCheckIds: [],
            commits: [],
            dependencies: [],
            expectationDrift: createEmptyIssueExpectationDrift(),
            number: input.number,
            priority: input.priority ?? null,
            status: input.status ?? 'queued',
            title: input.title,
            validations: [],
        };
        state.issues.push(issue);
    }
    if (input.title) issue.title = input.title;
    if (input.priority) issue.priority = input.priority;
    const candidateCommits = [...issue.commits];
    uniqueAppend(candidateCommits, input.commits ?? []);
    if (input.status === 'complete') {
        const committedHead = candidateCommits.at(-1);
        if (!committedHead) throw new Error(`Issue #${issue.number} completion requires a commit`);
        assertIssueExpectationDriftReady(issue, committedHead);
    }
    uniqueAppend(issue.dependencies, input.dependencies ?? []);
    uniqueAppend(issue.commits, candidateCommits);
    uniqueAppend(issue.acceptanceCheckIds, input.checks ?? []);
    uniqueAppend(issue.validations, input.validations ?? []);
    if (input.status) issue.status = input.status;
    if (!wasComplete && input.status === 'complete') {
        recordCostCheckpoint(state, { boundary: 'issue', issueNumber: issue.number });
    }
    addEvent(state, 'issue', `#${issue.number} -> ${issue.status}`);
    return state;
}

export function recordPullRequest(state: GoState, input: PullRequestInput): GoState {
    if (input.number !== undefined && (!Number.isSafeInteger(input.number) || input.number <= 0)) {
        throw new Error('PR number must be positive');
    }
    if (input.status === 'ready') {
        const headSha = input.headSha ?? state.pullRequest.headSha;
        if (!headSha) throw new Error('PR readiness requires the exact head');
        assertAllIssueExpectationDriftReady(state, headSha);
    }
    const isHeadChanged = Boolean(
        input.headSha && state.pullRequest.headSha && input.headSha !== state.pullRequest.headSha,
    );
    if (isHeadChanged && state.ciFallback.status !== 'not_requested') {
        addEvent(state, 'ci_fallback', `Invalidated fallback for ${state.ciFallback.headSha}`);
        state.ciFallback = createEmptyCiFallback();
    }
    if (isHeadChanged) {
        if (state.reviewGate.frozenHeadSha !== input.headSha) {
            state.reviewGate.frozenHeadSha = null;
        }
        /**
         * Acceptance decisions and pending publications bind one exact head. Preserve the immutable lineage so the
         * replacement head can append a new round, but reset every decision field before validating the new PR head.
         */
        const pendingPublication = state.acceptance.publication.pendingAttempt;
        if (pendingPublication) {
            if (pendingPublication.acceptanceId === state.acceptance.id) {
                state.acceptance.publication.pendingAttempt = null;
            } else {
                recordOrphanedAcceptance(state, {
                    acceptanceId: pendingPublication.acceptanceId,
                    reason: 'PR head changed before exact remote readback completed.',
                    verifyRunId: pendingPublication.verifyRunId,
                });
            }
            addEvent(
                state,
                'acceptance',
                `Invalidated pending publication ${pendingPublication.verifyRunId} for ${pendingPublication.headSha}`,
            );
        }
        state.acceptance.acceptedHeadSha = null;
        state.acceptance.status = 'not_started';
        state.acceptance.waivedHeadSha = null;
        state.acceptance.waiverReason = null;
        state.handoffReport = null;
        state.finalization = null;
    }
    state.pullRequest = {
        headSha: input.headSha ?? state.pullRequest.headSha,
        number: input.number ?? state.pullRequest.number,
        status: input.status ?? state.pullRequest.status,
        url: input.url ?? state.pullRequest.url,
    };
    if (input.branch) state.branch = input.branch;
    addEvent(
        state,
        'pull_request',
        `PR ${state.pullRequest.number ?? 'unset'} -> ${state.pullRequest.status}`,
    );
    return state;
}

export function recordWorktree(state: GoState, input: WorktreeInput, createdAt = now()): GoState {
    if (!isAbsolute(input.path) || !isAbsolute(input.mainCheckoutPath)) {
        throw new Error('Worktree paths must be absolute');
    }
    if (input.path === input.mainCheckoutPath) {
        throw new Error('Go worktree must be isolated from the main checkout');
    }
    if (
        state.worktree &&
        (state.worktree.baseSha !== input.baseSha ||
            state.worktree.mainCheckoutPath !== input.mainCheckoutPath ||
            state.worktree.path !== input.path)
    ) {
        throw new Error('A Go run cannot switch to a different worktree');
    }
    if (input.branch && state.branch && state.branch !== input.branch) {
        throw new Error('A Go run cannot switch to a different branch');
    }
    const worktree = {
        baseSha: input.baseSha,
        createdAt,
        mainCheckoutPath: input.mainCheckoutPath,
        path: input.path,
    };
    state.worktree ??= worktree;
    if (input.branch) {
        state.branch = input.branch;
    }
    addEvent(state, 'worktree', `${state.worktree.path} @ ${state.worktree.baseSha}`);
    return state;
}

export function recordAcceptance(state: GoState, input: AcceptanceInput): GoState {
    if (input.status === 'waived' && (!input.waivedHeadSha || !input.waiverReason?.trim())) {
        throw new Error('Acceptance waiver requires exact head and explicit reason');
    }
    if (input.id && state.acceptance.id && input.id !== state.acceptance.id) {
        throw new Error('Acceptance id cannot leave the frozen publication lineage');
    }
    if (input.url && state.acceptance.url && input.url !== state.acceptance.url) {
        throw new Error('Acceptance URL cannot leave the frozen publication lineage');
    }
    state.acceptance = {
        acceptedHeadSha: input.acceptedHeadSha ?? state.acceptance.acceptedHeadSha,
        id: input.id ?? state.acceptance.id,
        publication: state.acceptance.publication,
        round: state.acceptance.round,
        status: input.status ?? state.acceptance.status,
        url: input.url ?? state.acceptance.url,
        waivedHeadSha: input.waivedHeadSha ?? state.acceptance.waivedHeadSha,
        waiverReason: input.waiverReason ?? state.acceptance.waiverReason,
    };
    addEvent(state, 'acceptance', `Round ${state.acceptance.round} -> ${state.acceptance.status}`);
    return state;
}

export function recordNote(state: GoState, input: { kind: NoteKind; text: string }): GoState {
    const safe = sanitizeNoteText(input.text);
    const text =
        input.kind === 'workflow' ? validateHumanText(safe.text, 'workflow note') : safe.text;
    if (state.notes[input.kind].every((item) => item.text !== text)) {
        state.notes[input.kind].push({ at: now(), kind: input.kind, ...safe, text });
        addEvent(state, 'note', `${input.kind}: ${text}`);
    }
    return state;
}

export function validateState(state: unknown): GoState {
    const parsed = goStateSchema.parse(migrateState(state, SCHEMA_VERSION));
    if (parsed.status !== statusForPhase(parsed.phase)) {
        throw new Error('Invalid Go state: status does not match phase');
    }
    if (parsed.phase !== 'intake' && !parsed.runBudget.policyFrozenAt) {
        throw new Error('Invalid Go state: budget policy must be frozen after intake');
    }
    if (
        parsed.worktree &&
        (!isAbsolute(parsed.worktree.path) || !isAbsolute(parsed.worktree.mainCheckoutPath))
    ) {
        throw new Error('Invalid Go state: worktree paths must be absolute');
    }
    const pendingValidations = parsed.validations.filter(({ result }) => result === 'pending');
    if (pendingValidations.length > 1) {
        throw new Error('Invalid Go state: only one validation may be pending');
    }
    if (parsed.mutationLease?.kind === 'validation') {
        if (pendingValidations.every(({ id }) => id !== parsed.mutationLease?.holderId)) {
            throw new Error('Invalid Go state: validation lease has no matching pending receipt');
        }
    } else if (pendingValidations.length > 0) {
        throw new Error('Invalid Go state: pending validation has no durable mutation lease');
    }
    if (new Set(parsed.issues.map(({ number }) => number)).size !== parsed.issues.length) {
        throw new Error('Invalid Go state: duplicate issue number');
    }
    for (const kind of NOTE_KINDS) {
        if (parsed.notes[kind].some((note) => note.kind !== kind)) {
            throw new Error(`Invalid Go state: ${kind} note has mismatched structured kind`);
        }
    }
    if (
        parsed.ciFallback.status !== 'not_requested' &&
        parsed.ciFallback.headSha !== parsed.pullRequest.headSha
    ) {
        throw new Error('Invalid Go state: local CI fallback does not match the current PR head');
    }
    if (parsed.ciFallback.status !== 'not_requested') assertReviewHeadFrozen(parsed);
    if (['acceptance', 'acceptance_handoff', 'waiting_acceptance'].includes(parsed.phase)) {
        assertReviewHeadFrozen(parsed, parsed.pullRequest.headSha ?? undefined);
        assertDeliveryCanAdvance(parsed);
    }
    const unfinished = parsed.issues.filter(
        ({ status }) => !['committed', 'complete', 'deferred'].includes(status),
    );
    if (
        !['intake', 'planning', 'issue_execution'].includes(parsed.phase) &&
        unfinished.length > 0
    ) {
        throw new Error(
            `Invalid Go state: ${parsed.phase} has unfinished issues ${unfinished.map(({ number }) => `#${number}`).join(', ')}`,
        );
    }
    if (parsed.acceptance.status === 'accepted' && !parsed.acceptance.acceptedHeadSha) {
        throw new Error('Invalid Go state: accepted Acceptance requires --accepted-head-sha');
    }
    if (parsed.acceptance.status === 'accepted') {
        assertPublishedAcceptanceLineage(parsed, parsed.acceptance.acceptedHeadSha ?? undefined);
    }
    if (parsed.acceptance.status === 'waived' && !parsed.acceptance.waivedHeadSha) {
        throw new Error('Invalid Go state: waived Acceptance requires --waived-head-sha');
    }
    if (parsed.acceptance.status === 'pending') {
        assertPublishedAcceptanceLineage(parsed, parsed.pullRequest.headSha ?? undefined);
    }
    if (parsed.phase === 'waiting_acceptance') {
        assertHandoffReady(parsed, parsed.pullRequest.headSha ?? '');
    }
    if (
        ['merge', 'finalization', 'complete'].includes(parsed.phase) &&
        (!parsed.pullRequest.headSha || decisionHead(parsed) !== parsed.pullRequest.headSha)
    ) {
        throw new Error('Invalid Go state: merge requires the exact accepted or waived PR head');
    }
    if (
        ['finalization', 'complete'].includes(parsed.phase) &&
        parsed.pullRequest.status !== 'merged'
    ) {
        throw new Error('Invalid Go state: finalization requires a remotely merged pull request');
    }
    if (parsed.phase === 'complete') assertFinalizationComplete(parsed);
    return parsed;
}
