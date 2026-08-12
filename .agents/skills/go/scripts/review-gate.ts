import { z } from 'zod';

export const reviewPolicyModeSchema = z.enum(['full-once', 'quick', 'light']);
export const reviewModeSchema = z.enum(['full', 'quick', 'light']);
const reviewPhaseSchema = z.enum(['deep_review', 'delivery', 'unknown']);

export const reviewPolicySchema = z.object({
    frozenAt: z.string(),
    mode: reviewPolicyModeSchema,
    source: z.string().min(1),
});

const reviewDecisionSchema = z.object({
    baselineHeadSha: z.string().min(1).nullable(),
    baselineReviewId: z.string().min(1).nullable(),
    completedAt: z.string(),
    headSha: z.string().min(1),
    id: z.string().min(1),
    legacyMode: z.enum(['full', 'targeted', 'verification']).nullable().default(null),
    mode: reviewModeSchema,
    parentReviewId: z.string().min(1).nullable(),
    phase: reviewPhaseSchema,
    productP0: z.number().int().nonnegative(),
    productP1: z.number().int().nonnegative(),
    reviewedRange: z.string().min(1),
    scope: z.string().min(1),
});

export const reviewGateSchema = z.object({
    baselineReviewId: z.string().nullable(),
    frozenHeadSha: z.string().nullable(),
    rounds: z.array(reviewDecisionSchema),
});

export type ReviewGate = z.infer<typeof reviewGateSchema>;
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;
type ReviewMode = z.infer<typeof reviewModeSchema>;

interface ReviewContext {
    phase: string;
    reviewGate: ReviewGate;
    reviewPolicy: ReviewPolicy;
}

interface ReviewDecisionInput {
    baselineHeadSha?: string;
    baselineReviewId?: string;
    freeze: boolean;
    headSha: string;
    mode: ReviewMode;
    p0: number;
    p1: number;
    parentReviewId?: string;
    reviewedRange: string;
    scope: string;
}

const baselineModeByPolicy: Record<ReviewPolicy['mode'], ReviewMode> = {
    'full-once': 'full',
    'light': 'light',
    'quick': 'quick',
};

export function createReviewPolicy(
    mode: ReviewPolicy['mode'] = 'full-once',
    source = 'Go default',
    frozenAt = new Date().toISOString(),
): ReviewPolicy {
    return reviewPolicySchema.parse({ frozenAt, mode, source });
}

export function createEmptyReviewGate(): ReviewGate {
    return { baselineReviewId: null, frozenHeadSha: null, rounds: [] };
}

export function overrideReviewPolicy(
    state: ReviewContext,
    mode: ReviewPolicy['mode'],
    source: string,
    recordedAt = new Date().toISOString(),
): ReviewPolicy {
    if (!source.trim()) throw new Error('Review policy override requires a source');
    if (state.reviewGate.rounds.length > 0) {
        throw new Error('Review policy cannot change after the aggregate review baseline starts');
    }
    state.reviewPolicy = createReviewPolicy(mode, source.trim(), recordedAt);
    return state.reviewPolicy;
}

function nextReviewId(gate: ReviewGate): string {
    return `review-${String(gate.rounds.length + 1).padStart(3, '0')}`;
}

export function recordReviewDecision(
    state: ReviewContext,
    input: ReviewDecisionInput,
    recordedAt = new Date().toISOString(),
): ReviewGate {
    if (state.phase !== 'deep_review' && state.phase !== 'delivery') {
        throw new Error('Review decisions can be recorded only during deep review or delivery');
    }
    if (input.freeze && (input.p0 > 0 || input.p1 > 0)) {
        throw new Error('Cannot freeze a head with product P0 or P1 findings');
    }

    const baseline = state.reviewGate.baselineReviewId
        ? state.reviewGate.rounds.find(({ id }) => id === state.reviewGate.baselineReviewId)
        : undefined;
    const parent = state.reviewGate.rounds.at(-1);
    const isBaseline = !baseline;
    if (isBaseline) {
        const requiredMode = baselineModeByPolicy[state.reviewPolicy.mode];
        if (input.mode !== requiredMode) {
            throw new Error(
                `Review policy ${state.reviewPolicy.mode} requires a ${requiredMode} baseline`,
            );
        }
        if (input.baselineHeadSha || input.baselineReviewId || input.parentReviewId) {
            throw new Error('The aggregate review baseline cannot declare parent lineage');
        }
    } else {
        if (!parent) throw new Error('Review lineage is missing its parent decision');
        if (input.mode === 'full') {
            throw new Error('A Go run allows exactly one full deep review baseline');
        }
        if (input.mode !== 'light') {
            throw new Error('Post-baseline code changes require a light delta review');
        }
        if (
            input.baselineReviewId !== baseline.id ||
            input.baselineHeadSha !== baseline.headSha ||
            input.parentReviewId !== parent?.id
        ) {
            throw new Error('Light delta review requires exact baseline and parent review lineage');
        }
        const expectedRange = `${parent.headSha}..${input.headSha}`;
        if (input.reviewedRange !== expectedRange) {
            throw new Error(`Light delta review range must be ${expectedRange}`);
        }
    }

    const decision = reviewDecisionSchema.parse({
        baselineHeadSha: isBaseline ? null : baseline.headSha,
        baselineReviewId: isBaseline ? null : baseline.id,
        completedAt: recordedAt,
        headSha: input.headSha,
        id: nextReviewId(state.reviewGate),
        legacyMode: null,
        mode: input.mode,
        parentReviewId: isBaseline ? null : parent?.id,
        phase: state.phase,
        productP0: input.p0,
        productP1: input.p1,
        reviewedRange: input.reviewedRange,
        scope: input.scope,
    });
    state.reviewGate.rounds.push(decision);
    if (isBaseline) state.reviewGate.baselineReviewId = decision.id;
    state.reviewGate.frozenHeadSha = input.freeze ? decision.headSha : null;
    return state.reviewGate;
}

export function assertReviewHeadFrozen(state: ReviewContext, headSha?: string): void {
    if (!state.reviewGate.frozenHeadSha) {
        throw new Error('Delivery requires an explicitly frozen review-clean head');
    }
    if (headSha && state.reviewGate.frozenHeadSha !== headSha) {
        throw new Error(
            'Delivery requires the exact current PR head to be review-clean and frozen',
        );
    }
}
