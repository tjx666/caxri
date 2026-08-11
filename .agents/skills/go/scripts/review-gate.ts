import { z } from 'zod';

export const reviewModeSchema = z.enum(['full', 'targeted', 'verification']);
const reviewPhaseSchema = z.enum(['deep_review', 'delivery', 'unknown']);

const reviewDecisionSchema = z.object({
    authorization: z.string().min(1).optional(),
    completedAt: z.string(),
    headSha: z.string().min(1),
    mode: reviewModeSchema,
    phase: reviewPhaseSchema,
    productP0: z.number().int().nonnegative(),
    productP1: z.number().int().nonnegative(),
    scope: z.string().min(1),
    verificationCapAuthorization: z.string().min(1).nullable().default(null),
});

export const reviewGateSchema = z.object({
    frozenHeadSha: z.string().nullable(),
    rounds: z.array(reviewDecisionSchema),
});

export type ReviewGate = z.infer<typeof reviewGateSchema>;
type ReviewMode = z.infer<typeof reviewModeSchema>;

interface ReviewContext {
    phase: string;
    reviewGate: ReviewGate;
}

interface ReviewDecisionInput {
    authorization?: string;
    freeze: boolean;
    headSha: string;
    mode: ReviewMode;
    p0: number;
    p1: number;
    scope: string;
    verificationCapAuthorization?: string;
}

const MAX_FULL_REVIEW_ROUNDS = 3;
const MAX_PRE_DELIVERY_VERIFICATION_DECISIONS = 1;
const MAX_DELIVERY_VERIFICATION_DECISIONS = 3;
const MAX_AUTHORIZED_DELIVERY_VERIFICATION_DECISIONS = 4;

export function createEmptyReviewGate(): ReviewGate {
    return { frozenHeadSha: null, rounds: [] };
}

export function recordReviewDecision(
    state: ReviewContext,
    input: ReviewDecisionInput,
    recordedAt = new Date().toISOString(),
): ReviewGate {
    if (state.phase !== 'deep_review' && state.phase !== 'delivery') {
        throw new Error('Review decisions can be recorded only during deep review or delivery');
    }
    const reviewPhase = state.phase;
    const fullRounds = state.reviewGate.rounds.filter(({ mode }) => mode === 'full').length;
    if (input.mode === 'full') {
        if (fullRounds >= MAX_FULL_REVIEW_ROUNDS) {
            throw new Error(
                'Full deep review is limited to three rounds; use one targeted P0/P1 verification or escalate the architecture decision',
            );
        }
    } else if (input.mode === 'targeted') {
        if (fullRounds === 0) {
            throw new Error('Targeted verification requires a prior full Goal-range review');
        }
        if (state.phase === 'deep_review' && fullRounds < MAX_FULL_REVIEW_ROUNDS) {
            throw new Error(
                'Deep-review targeted verification is allowed only after the third full review',
            );
        }
        const lastFullIndex = state.reviewGate.rounds.findLastIndex(({ mode }) => mode === 'full');
        const targetedDecisions = state.reviewGate.rounds
            .slice(lastFullIndex + 1)
            .filter(({ mode }) => mode === 'targeted');
        if (fullRounds < MAX_FULL_REVIEW_ROUNDS && targetedDecisions.length > 0) {
            throw new Error('Only one targeted verification is allowed after each full review');
        }
        if (targetedDecisions.length >= 2) {
            throw new Error(
                'A Go run allows at most two targeted verifications after a full review',
            );
        }
        if (targetedDecisions.length === 1) {
            const previous = targetedDecisions[0];
            if (previous.productP0 === 0 && previous.productP1 === 0) {
                throw new Error(
                    'An extra targeted verification is invalid when the prior targeted verification found no product P0/P1',
                );
            }
            if (!input.authorization?.trim()) {
                throw new Error(
                    'A second targeted verification requires explicit user authorization after the first found product P0/P1',
                );
            }
        }
    } else {
        if (fullRounds === 0) {
            throw new Error('Verification-only freeze requires a prior full Goal-range review');
        }
        if (!input.freeze)
            throw new Error('Verification-only review decisions must freeze the head');
        const verificationDecisions = state.reviewGate.rounds.filter(
            ({ mode }) => mode === 'verification',
        );
        const uncertainDecisions = verificationDecisions.filter(
            ({ phase }) => !phase || phase === 'unknown',
        );
        const preDeliveryDecisions =
            verificationDecisions.filter(({ phase }) => phase === 'deep_review').length +
            uncertainDecisions.length;
        const deliveryDecisions =
            verificationDecisions.filter(({ phase }) => phase === 'delivery').length +
            uncertainDecisions.length;
        if (
            reviewPhase === 'deep_review' &&
            preDeliveryDecisions >= MAX_PRE_DELIVERY_VERIFICATION_DECISIONS
        ) {
            throw new Error(
                'A Go run can record at most one pre-delivery verification-only freeze',
            );
        }
        if (
            reviewPhase === 'delivery' &&
            deliveryDecisions >= MAX_AUTHORIZED_DELIVERY_VERIFICATION_DECISIONS
        ) {
            throw new Error(
                'A Go run can record at most four delivery-stage verification-only freezes',
            );
        }
        if (
            reviewPhase === 'delivery' &&
            deliveryDecisions >= MAX_DELIVERY_VERIFICATION_DECISIONS &&
            !input.authorization?.trim()
        ) {
            throw new Error(
                'A fourth delivery-stage verification-only freeze requires explicit user authorization',
            );
        }
    }
    if (input.freeze && (input.p0 > 0 || input.p1 > 0)) {
        throw new Error('Cannot freeze a head with product P0 or P1 findings');
    }

    const decision = reviewDecisionSchema.parse({
        authorization: input.authorization?.trim() || undefined,
        completedAt: recordedAt,
        headSha: input.headSha,
        mode: input.mode,
        phase: reviewPhase,
        productP0: input.p0,
        productP1: input.p1,
        scope: input.scope,
        verificationCapAuthorization: input.verificationCapAuthorization?.trim() || null,
    });
    state.reviewGate.rounds.push(decision);
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
