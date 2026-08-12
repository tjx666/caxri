import { isAbsolute } from 'node:path';
import { z } from 'zod';

import { validateHumanText } from '../../acceptance/scripts/validate-report';
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
    assertReviewHeadFrozen,
    createEmptyReviewGate,
    createReviewPolicy,
    reviewGateSchema,
    reviewPolicySchema,
} from './review-gate';
import { createRunBudget, ensurePhaseCheckpoint, runBudgetSchema } from './run-budget';
import { migrateState } from './state-migration';
import { validationsSchema } from './validation-gate';

export const SCHEMA_VERSION = 6;
const MAX_EVENTS = 120;

export const PHASES = [
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
export type IssueStatus = z.infer<typeof issueStatusSchema>;
export type PullRequestStatus = z.infer<typeof pullRequestStatusSchema>;
export type AcceptanceStatus = z.infer<typeof acceptanceStatusSchema>;
export type NoteKind = z.infer<typeof noteKindSchema>;

const eventSchema = z.object({ at: z.string(), detail: z.string(), type: z.string() });
const noteSchema = z.object({ at: z.string(), text: z.string() });
const issueSchema = z.object({
    acceptanceCheckIds: z.array(z.string()),
    commits: z.array(z.string()),
    dependencies: z.array(z.number().int().positive()),
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

export const goStateSchema = z.object({
    acceptance: z.object({
        acceptedHeadSha: z.string().nullable(),
        id: z.string().nullable(),
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
    round?: number;
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

export function statusForPhase(phase: Phase): GoState['status'] {
    if (phase === 'complete') return 'complete';
    if (phase === 'waiting_acceptance') return 'waiting_acceptance';
    if (phase === 'intake' || phase === 'planning') return 'planning';
    return 'active';
}

export function addEvent(state: GoState, type: string, detail: string): void {
    state.events.push({ at: now(), detail, type });
    while (state.events.length > MAX_EVENTS) {
        const removable = state.events.findIndex(
            (event) => event.type !== 'init' && event.type !== 'phase',
        );
        if (removable < 0) break;
        state.events.splice(removable, 1);
    }
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
        notes: { technical_debt: [], token_waste: [], workflow: [] },
        objective,
        phase: 'intake',
        pullRequest: { headSha: null, number: null, status: 'none', url: null },
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

export function transitionState(state: GoState, phase: Phase, reason = ''): GoState {
    const allowed = PHASE_TRANSITIONS[state.phase];
    if (!allowed.has(phase))
        throw new Error(`Invalid phase transition: ${state.phase} -> ${phase}`);
    ensurePhaseCheckpoint(state);
    if (state.phase === 'deep_review' && phase === 'delivery') assertReviewHeadFrozen(state);
    if (state.phase === 'delivery' && ['acceptance', 'acceptance_handoff'].includes(phase)) {
        assertReviewHeadFrozen(state, state.pullRequest.headSha ?? undefined);
        assertDeliveryCanAdvance(state);
        if (phase === 'acceptance_handoff' && state.acceptance.status !== 'waived') {
            throw new Error('Only an explicit Acceptance waiver can skip directly to handoff');
        }
    }
    if (state.phase === 'acceptance' && phase === 'acceptance_handoff') {
        if (
            state.acceptance.status !== 'pending' ||
            !state.acceptance.id ||
            !state.acceptance.url ||
            state.acceptance.round < 1
        ) {
            throw new Error('Acceptance handoff requires a published pending Acceptance round');
        }
    }
    if (state.phase === 'acceptance_handoff' && phase === 'waiting_acceptance') {
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
    }
    if (state.phase === 'merge' && phase === 'finalization') {
        if (state.pullRequest.status !== 'merged') {
            throw new Error('Finalization requires a remotely merged pull request');
        }
    }
    if (state.phase === 'finalization' && phase === 'complete') {
        assertFinalizationComplete(state);
    }

    const previous = state.phase;
    state.phase = phase;
    state.status = statusForPhase(phase);
    addEvent(state, 'phase', `${previous} -> ${phase}${reason ? `: ${reason}` : ''}`);
    return state;
}

export function upsertIssue(state: GoState, input: IssueInput): GoState {
    if (!Number.isInteger(input.number) || input.number <= 0) {
        throw new Error('Issue number must be positive');
    }
    if ((input.dependencies ?? []).some((number) => !Number.isInteger(number) || number <= 0)) {
        throw new Error('Issue dependencies must be positive integers');
    }
    let issue = state.issues.find((item) => item.number === input.number);
    if (!issue) {
        if (!input.title) throw new Error('A new issue requires --title');
        issue = {
            acceptanceCheckIds: [],
            commits: [],
            dependencies: [],
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
    if (input.status) issue.status = input.status;
    uniqueAppend(issue.dependencies, input.dependencies ?? []);
    uniqueAppend(issue.commits, input.commits ?? []);
    uniqueAppend(issue.acceptanceCheckIds, input.checks ?? []);
    uniqueAppend(issue.validations, input.validations ?? []);
    addEvent(state, 'issue', `#${issue.number} -> ${issue.status}`);
    return state;
}

export function recordPullRequest(state: GoState, input: PullRequestInput): GoState {
    if (input.number !== undefined && (!Number.isInteger(input.number) || input.number <= 0)) {
        throw new Error('PR number must be positive');
    }
    const headChanged = Boolean(
        input.headSha && state.pullRequest.headSha && input.headSha !== state.pullRequest.headSha,
    );
    if (headChanged && state.ciFallback.status !== 'not_requested') {
        addEvent(state, 'ci_fallback', `Invalidated fallback for ${state.ciFallback.headSha}`);
        state.ciFallback = createEmptyCiFallback();
    }
    if (headChanged) {
        if (state.reviewGate.frozenHeadSha !== input.headSha) {
            state.reviewGate.frozenHeadSha = null;
        }
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
    const worktree = {
        baseSha: input.baseSha,
        createdAt,
        mainCheckoutPath: input.mainCheckoutPath,
        path: input.path,
    };
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
    state.worktree ??= worktree;
    if (input.branch) {
        state.branch = input.branch;
    }
    addEvent(state, 'worktree', `${state.worktree.path} @ ${state.worktree.baseSha}`);
    return state;
}

export function recordAcceptance(state: GoState, input: AcceptanceInput): GoState {
    if (input.round !== undefined && (!Number.isInteger(input.round) || input.round < 0)) {
        throw new Error('Acceptance round must be a non-negative integer');
    }
    if (input.status === 'waived' && (!input.waivedHeadSha || !input.waiverReason?.trim())) {
        throw new Error('Acceptance waiver requires exact head and explicit reason');
    }
    state.acceptance = {
        acceptedHeadSha: input.acceptedHeadSha ?? state.acceptance.acceptedHeadSha,
        id: input.id ?? state.acceptance.id,
        round: input.round ?? state.acceptance.round,
        status: input.status ?? state.acceptance.status,
        url: input.url ?? state.acceptance.url,
        waivedHeadSha: input.waivedHeadSha ?? state.acceptance.waivedHeadSha,
        waiverReason: input.waiverReason ?? state.acceptance.waiverReason,
    };
    addEvent(state, 'acceptance', `Round ${state.acceptance.round} -> ${state.acceptance.status}`);
    return state;
}

export function recordNote(state: GoState, input: { kind: NoteKind; text: string }): GoState {
    if (!input.text.trim()) throw new Error('Note text is required');
    const normalized =
        input.kind === 'workflow'
            ? validateHumanText(input.text, 'workflow note')
            : input.text.trim();
    if (!state.notes[input.kind].some((item) => item.text === normalized)) {
        state.notes[input.kind].push({ at: now(), text: normalized });
        addEvent(state, 'note', `${input.kind}: ${normalized}`);
    }
    return state;
}

export function validateState(state: unknown): GoState {
    const parsed = goStateSchema.parse(migrateState(state, SCHEMA_VERSION));
    if (parsed.status !== statusForPhase(parsed.phase)) {
        throw new Error('Invalid Go state: status does not match phase');
    }
    if (parsed.worktree) {
        if (!isAbsolute(parsed.worktree.path) || !isAbsolute(parsed.worktree.mainCheckoutPath)) {
            throw new Error('Invalid Go state: worktree paths must be absolute');
        }
    }
    if (new Set(parsed.issues.map(({ number }) => number)).size !== parsed.issues.length) {
        throw new Error('Invalid Go state: duplicate issue number');
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
    if (parsed.acceptance.status === 'waived' && !parsed.acceptance.waivedHeadSha) {
        throw new Error('Invalid Go state: waived Acceptance requires --waived-head-sha');
    }
    if (parsed.phase === 'waiting_acceptance') {
        assertHandoffReady(parsed, parsed.pullRequest.headSha ?? '');
    }
    if (['merge', 'finalization', 'complete'].includes(parsed.phase)) {
        if (!parsed.pullRequest.headSha || decisionHead(parsed) !== parsed.pullRequest.headSha) {
            throw new Error(
                'Invalid Go state: merge requires the exact accepted or waived PR head',
            );
        }
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
