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

const costCheckpointSchema = z.object({
    commitCount: measuredValueSchema,
    elapsedSeconds: measuredValueSchema,
    fileCount: measuredValueSchema,
    fullReviewCount: z.number().int().nonnegative(),
    hardThresholdReached: z.boolean(),
    phase: z.string().min(1),
    recordedAt: z.string(),
    tokens: measuredValueSchema,
    validationRepairCount: z.number().int().nonnegative(),
});

const routedWorkSchema = z.object({
    at: z.string(),
    reason: z.string().min(1),
    title: z.string().min(1),
});

export const runBudgetSchema = z.object({
    checkpoints: z.array(costCheckpointSchema),
    policy: budgetPolicySchema,
    routedWork: z.array(routedWorkSchema),
});

export type RunBudget = z.infer<typeof runBudgetSchema>;
type MeasuredValue = z.infer<typeof measuredValueSchema>;

interface BudgetContext {
    phase: string;
    reviewGate: { rounds: Array<{ mode: string }> };
    runBudget: RunBudget;
    validations: Array<{ attempt: number }>;
}

interface CheckpointInput {
    commitCount: MeasuredValue;
    elapsedSeconds: MeasuredValue;
    fileCount: MeasuredValue;
    tokens: MeasuredValue;
}

export function createRunBudget(): RunBudget {
    return {
        checkpoints: [],
        policy: { ...DEFAULT_GO_BUDGET_POLICY },
        routedWork: [],
    };
}

function reaches(value: MeasuredValue, threshold: number): boolean {
    return value !== 'unavailable' && value >= threshold;
}

export function recordCostCheckpoint(
    state: BudgetContext,
    input: CheckpointInput,
    recordedAt = new Date().toISOString(),
): RunBudget {
    const hardThresholdReached =
        reaches(input.tokens, state.runBudget.policy.hardTokens) ||
        reaches(input.elapsedSeconds, state.runBudget.policy.hardElapsedSeconds);
    const checkpoint = costCheckpointSchema.parse({
        ...input,
        fullReviewCount: state.reviewGate.rounds.filter(({ mode }) => mode === 'full').length,
        hardThresholdReached,
        phase: state.phase,
        recordedAt,
        validationRepairCount: state.validations.filter(({ attempt }) => attempt > 1).length,
    });
    const existing = state.runBudget.checkpoints.findIndex(({ phase }) => phase === state.phase);
    if (existing >= 0) state.runBudget.checkpoints[existing] = checkpoint;
    else state.runBudget.checkpoints.push(checkpoint);
    return state.runBudget;
}

export function ensurePhaseCheckpoint(state: BudgetContext): RunBudget {
    if (!state.runBudget.checkpoints.some(({ phase }) => phase === state.phase)) {
        recordCostCheckpoint(state, {
            commitCount: 'unavailable',
            elapsedSeconds: 'unavailable',
            fileCount: 'unavailable',
            tokens: 'unavailable',
        });
    }
    return state.runBudget;
}

export function routeWorkflowWork(
    state: BudgetContext,
    input: { blocking: boolean; title: string },
    recordedAt = new Date().toISOString(),
): 'current' | 'follow_up' {
    const thresholdReached = state.runBudget.checkpoints.some(
        ({ hardThresholdReached }) => hardThresholdReached,
    );
    if (!thresholdReached || input.blocking) return 'current';
    if (!state.runBudget.routedWork.some(({ title }) => title === input.title)) {
        state.runBudget.routedWork.push({
            at: recordedAt,
            reason: 'Go hard budget threshold reached; non-blocking workflow work moved out of scope',
            title: input.title,
        });
    }
    return 'follow_up';
}
