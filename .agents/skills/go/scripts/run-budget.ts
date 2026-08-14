import { z } from 'zod';

const measuredValueSchema = z.union([z.number().int().nonnegative(), z.literal('unavailable')]);
const DEFAULT_GO_BUDGET_POLICY = {
    hardElapsedSeconds: 5_400,
    hardTokens: 1_000_000,
    validationRepairLimit: 3,
} as const;

const budgetPolicySchema = z.object({
    hardElapsedSeconds: z.number().int().positive(),
    hardTokens: z.number().int().positive(),
    validationRepairLimit: z.number().int().positive(),
});

export const checkpointBoundarySchema = z.enum(['batch', 'issue', 'manual', 'phase']);
const costCheckpointSchema = z.object({
    boundary: checkpointBoundarySchema,
    commitCount: measuredValueSchema,
    elapsedSeconds: z.number().int().nonnegative(),
    fileCount: measuredValueSchema,
    fullReviewCount: z.number().int().nonnegative(),
    hardThresholdReached: z.boolean(),
    headSha: z.string().min(1).nullable(),
    issueNumber: z.number().int().positive().nullable(),
    phase: z.string().min(1),
    recordedAt: z.string(),
    reviewFindingCount: z.number().int().nonnegative(),
    tokenTelemetry: z.enum(['available', 'degraded']),
    tokens: measuredValueSchema,
    validationAttemptCount: z.number().int().nonnegative(),
    validationRepairCount: z.number().int().nonnegative(),
});

const routedWorkSchema = z.object({
    at: z.string(),
    reason: z.string().min(1),
    title: z.string().min(1),
});

const containmentSchema = z.object({
    activatedAt: z.string(),
    active: z.literal(true),
    droppedWork: z.array(z.enum(['discretionary_probes', 'optional_proof', 'p2_p3_expansion'])),
    reason: z.string().min(1),
    revisedEta: z.string().min(1),
});

const repairStopSchema = z.object({
    at: z.string(),
    lineageId: z.string().min(1),
    reason: z.string().min(1),
});

export const runBudgetSchema = z.object({
    checkpoints: z.array(costCheckpointSchema),
    containment: containmentSchema.nullable(),
    policy: budgetPolicySchema,
    policyFrozenAt: z.string().nullable(),
    repairStops: z.array(repairStopSchema),
    routedWork: z.array(routedWorkSchema),
});

export type RunBudget = z.infer<typeof runBudgetSchema>;
type MeasuredValue = z.infer<typeof measuredValueSchema>;

interface BudgetContext {
    createdAt: string;
    phase: string;
    reviewGate: { rounds: Array<{ mode: string; productP0: number; productP1: number }> };
    runBudget: RunBudget;
    validations: Array<{ attempt: number }>;
}

interface CheckpointInput {
    boundary?: z.infer<typeof checkpointBoundarySchema>;
    commitCount?: MeasuredValue;
    fileCount?: MeasuredValue;
    issueNumber?: number;
    headSha?: string;
    revisedEta?: string;
    tokens?: MeasuredValue;
}

export function createRunBudget(): RunBudget {
    return {
        checkpoints: [],
        containment: null,
        policy: { ...DEFAULT_GO_BUDGET_POLICY },
        policyFrozenAt: null,
        repairStops: [],
        routedWork: [],
    };
}

export function freezeRunBudgetPolicy(
    state: Pick<BudgetContext, 'runBudget'>,
    frozenAt = new Date().toISOString(),
): void {
    state.runBudget.policyFrozenAt ??= frozenAt;
}

export function updateRunBudgetPolicy(
    state: Pick<BudgetContext, 'runBudget'>,
    policy: RunBudget['policy'],
): void {
    if (state.runBudget.policyFrozenAt) {
        throw new Error('Go budget policy cannot change after intake');
    }
    state.runBudget.policy = budgetPolicySchema.parse(policy);
}

function reaches(value: MeasuredValue, threshold: number): boolean {
    return value !== 'unavailable' && value >= threshold;
}

function elapsedSeconds(createdAt: string, recordedAt: string): number {
    const elapsed = Date.parse(recordedAt) - Date.parse(createdAt);
    if (!Number.isFinite(elapsed) || elapsed < 0) {
        throw new Error('Go checkpoint timestamps cannot produce a valid elapsed duration');
    }
    return Math.floor(elapsed / 1_000);
}

export function recordCostCheckpoint(
    state: BudgetContext,
    input: CheckpointInput = {},
    recordedAt = new Date().toISOString(),
): RunBudget {
    const elapsed = elapsedSeconds(state.createdAt, recordedAt);
    const tokens = input.tokens ?? 'unavailable';
    const hardThresholdReached =
        reaches(tokens, state.runBudget.policy.hardTokens) ||
        elapsed >= state.runBudget.policy.hardElapsedSeconds;
    const checkpoint = costCheckpointSchema.parse({
        boundary: input.boundary ?? 'manual',
        commitCount: input.commitCount ?? 'unavailable',
        elapsedSeconds: elapsed,
        fileCount: input.fileCount ?? 'unavailable',
        fullReviewCount: state.reviewGate.rounds.filter(({ mode }) => mode === 'full').length,
        hardThresholdReached,
        headSha: input.headSha ?? null,
        issueNumber: input.issueNumber ?? null,
        phase: state.phase,
        recordedAt,
        reviewFindingCount: state.reviewGate.rounds.reduce(
            (total, { productP0, productP1 }) => total + productP0 + productP1,
            0,
        ),
        tokenTelemetry: tokens === 'unavailable' ? 'degraded' : 'available',
        tokens,
        validationAttemptCount: state.validations.length,
        validationRepairCount: state.validations.filter(({ attempt }) => attempt > 1).length,
    });
    state.runBudget.checkpoints.push(checkpoint);
    if (hardThresholdReached && !state.runBudget.containment) {
        state.runBudget.containment = containmentSchema.parse({
            activatedAt: recordedAt,
            active: true,
            droppedWork: ['optional_proof', 'p2_p3_expansion', 'discretionary_probes'],
            reason: 'Go hard budget threshold reached; required terminal outcome remains active',
            revisedEta: input.revisedEta?.trim() || 'Re-estimate at the next safe issue boundary',
        });
    }
    return state.runBudget;
}

export function enrichIssueCheckpoint(
    state: Pick<BudgetContext, 'runBudget'>,
    input: { commitCount: number; fileCount: number; headSha: string; issueNumber: number },
): void {
    const checkpoint = state.runBudget.checkpoints.findLast(
        ({ boundary, issueNumber }) => boundary === 'issue' && issueNumber === input.issueNumber,
    );
    if (!checkpoint) throw new Error(`No issue checkpoint exists for #${input.issueNumber}`);
    checkpoint.commitCount = input.commitCount;
    checkpoint.fileCount = input.fileCount;
    checkpoint.headSha = input.headSha;
}

export function ensurePhaseCheckpoint(state: BudgetContext): RunBudget {
    if (
        !state.runBudget.checkpoints.some(
            ({ boundary, phase }) => boundary === 'phase' && phase === state.phase,
        )
    ) {
        recordCostCheckpoint(state, { boundary: 'phase' });
    }
    return state.runBudget;
}

export function routeWorkflowWork(
    state: BudgetContext,
    input: { blocking: boolean; title: string },
    recordedAt = new Date().toISOString(),
): 'current' | 'follow_up' {
    if (!state.runBudget.containment || input.blocking) return 'current';
    if (!state.runBudget.routedWork.some(({ title }) => title === input.title)) {
        state.runBudget.routedWork.push({
            at: recordedAt,
            reason: 'Go hard budget threshold reached; non-blocking workflow work moved out of scope',
            title: input.title,
        });
    }
    return 'follow_up';
}
