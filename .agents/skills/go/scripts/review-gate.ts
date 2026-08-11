import { z } from 'zod';

export const reviewModeSchema = z.enum(['full', 'targeted', 'verification']);

const reviewDecisionSchema = z.object({
    authorization: z.string().min(1).optional(),
    completedAt: z.string(),
    headSha: z.string().min(1),
    mode: reviewModeSchema,
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
const MAX_VERIFICATION_DECISIONS = 3;
const MAX_AUTHORIZED_VERIFICATION_DECISIONS = MAX_VERIFICATION_DECISIONS + 1;

export function createEmptyReviewGate(): ReviewGate {
    return { frozenHeadSha: null, rounds: [] };
}

export function recordReviewDecision(
    state: ReviewContext,
    input: ReviewDecisionInput,
    recordedAt = new Date().toISOString(),
): ReviewGate {
    if (!['deep_review', 'delivery'].includes(state.phase)) {
        throw new Error('Review decisions can be recorded only during deep review or delivery');
    }
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
        ).length;
        if (verificationDecisions >= MAX_VERIFICATION_DECISIONS) {
            const authorization = input.verificationCapAuthorization?.trim();
            if (!authorization) {
                throw new Error(
                    'A Go run can record at most three verification-only head freezes without explicit user authorization',
                );
            }
            if (verificationDecisions >= MAX_AUTHORIZED_VERIFICATION_DECISIONS) {
                throw new Error(
                    'A Go run can record only one explicitly authorized verification-cap exception',
                );
            }
        } else if (input.verificationCapAuthorization) {
            throw new Error(
                'Verification-cap authorization is valid only after the default three-freeze limit is reached',
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
