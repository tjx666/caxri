import { z } from 'zod';

import type { CiPlatformReceipt } from './ci-platform-receipt';
import { assertCanonicalPlatformNeutralGate } from './platform-neutral-gates';

const platformGateReceiptSchema = z.object({
    ciCommands: z.array(z.string()),
    ciRunId: z.number().int().positive().nullable(),
    ciRunUrl: z.url().nullable(),
    localCommands: z.array(z.string()),
    source: z.enum(['ci', 'local']),
});

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
    platformGateReceipt: platformGateReceiptSchema.nullable().default(null),
    productP0: z.number().int().nonnegative(),
    productP1: z.number().int().nonnegative(),
    reviewedRange: z.string().min(1),
    scope: z.string().min(1),
});

type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

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
    validations: Array<{ command: string; headSha: string; kind: string; result: string }>;
}

interface ReviewHeadContext {
    reviewGate: ReviewGate;
}

interface ReviewHeadReconciliationContext extends ReviewContext {
    acceptance: {
        acceptedHeadSha: string | null;
        id: string | null;
        publication: {
            history: unknown[];
            orphanedStandalones: unknown[];
            pendingAttempt: unknown;
        };
        round: number;
        status: string;
        url: string | null;
        waivedHeadSha: string | null;
        waiverReason: string | null;
    };
    ciFallback: { status: string };
    events: Array<{ at: string; detail: string; type: string }>;
    finalization: unknown;
    handoffReport: unknown;
    mutationLease: unknown;
    pullRequest: { headSha: string | null };
    resourceCleanup: unknown;
    validations: Array<{
        command: string;
        headSha: string;
        kind: string;
        result: string;
        startedAt?: string;
    }>;
}

export interface ReviewHeadReconciliation {
    actualHeadSha: string;
    correctedRange: string;
    original: ReviewDecision;
}

interface ReviewDecisionInput {
    baselineHeadSha?: string;
    baselineReviewId?: string;
    ciReceipt?: CiPlatformReceipt | null;
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

function assertCompleteReviewLineage(state: ReviewContext): void {
    const baseline = state.reviewGate.rounds.find(
        ({ id }) => id === state.reviewGate.baselineReviewId,
    );
    if (!baseline || state.reviewGate.rounds[0] !== baseline) {
        throw new Error('Review head reconciliation requires an intact aggregate baseline');
    }
    const expectedBaselineMode =
        state.reviewPolicy.mode === 'full-once' ? 'full' : state.reviewPolicy.mode;
    const complete = state.reviewGate.rounds.every((decision, index, rounds) => {
        if (index === 0) {
            return (
                decision.mode === expectedBaselineMode &&
                decision.baselineReviewId === null &&
                decision.baselineHeadSha === null &&
                decision.parentReviewId === null
            );
        }
        const parent = rounds[index - 1];
        return (
            decision.mode === 'light' &&
            decision.baselineReviewId === baseline.id &&
            decision.baselineHeadSha === baseline.headSha &&
            decision.parentReviewId === parent.id &&
            decision.reviewedRange === `${parent.headSha}..${decision.headSha}`
        );
    });
    if (!complete) throw new Error('Review head reconciliation requires intact review lineage');
}

/**
 * Restricts amendment to an unconsumed latest review so a transcription repair cannot rewrite evidence that later
 * delivery decisions already trusted. The Git-backed caller separately proves that the old commit is nonexistent.
 */
export function planLatestReviewHeadReconciliation(
    state: ReviewHeadReconciliationContext,
    input: { actualHeadSha: string; reason: string; reviewId: string },
): ReviewHeadReconciliation {
    if (state.phase !== 'deep_review' && state.phase !== 'delivery') {
        throw new Error(
            'Review head reconciliation is allowed only during deep review or delivery',
        );
    }
    if (state.mutationLease) {
        throw new Error('Review head reconciliation requires no active mutation lease');
    }
    const reason = input.reason.trim();
    if (!reason) throw new Error('Review head reconciliation requires an explicit reason');
    assertCompleteReviewLineage(state);
    const latest = state.reviewGate.rounds.at(-1);
    const parent = state.reviewGate.rounds.at(-2);
    if (
        !latest ||
        !parent ||
        latest.id !== input.reviewId ||
        latest.id === state.reviewGate.baselineReviewId ||
        latest.productP0 !== 0 ||
        latest.productP1 !== 0 ||
        state.reviewGate.frozenHeadSha !== latest.headSha
    ) {
        throw new Error(
            'Review head reconciliation requires the latest frozen nonbaseline clean-verdict round',
        );
    }
    if (
        input.actualHeadSha === latest.headSha ||
        input.actualHeadSha === parent.headSha ||
        state.pullRequest.headSha === latest.headSha ||
        state.pullRequest.headSha === input.actualHeadSha
    ) {
        throw new Error('Review head reconciliation requires an unconsumed distinct current HEAD');
    }
    const reviewEventDetail = `${latest.id} ${latest.mode} ${latest.reviewedRange}`;
    const latestReviewEvent = state.events.findLast(({ type }) => type === 'review');
    if (
        !latestReviewEvent ||
        latestReviewEvent.at < latest.completedAt ||
        latestReviewEvent.detail !== reviewEventDetail
    ) {
        throw new Error(
            'Review head reconciliation cannot prove the latest review history is still live',
        );
    }
    const hasConsumingEvent = state.events.some(({ at, detail, type }) => {
        if (at <= latest.completedAt) return false;
        if (
            [
                'acceptance',
                'ci_fallback',
                'finalization',
                'handoff_report',
                'pull_request',
                'resource_cleanup',
                'validation',
            ].includes(type)
        ) {
            return true;
        }
        return (
            type === 'phase' &&
            /-> (?:acceptance|acceptance_handoff|complete|finalization|merge|waiting_acceptance)(?::|$)/u.test(
                detail,
            )
        );
    });
    if (
        hasConsumingEvent ||
        state.validations.some(({ startedAt }) => startedAt && startedAt >= latest.completedAt) ||
        state.ciFallback.status !== 'not_requested' ||
        state.acceptance.status !== 'not_started' ||
        state.acceptance.round !== 0 ||
        state.acceptance.id !== null ||
        state.acceptance.url !== null ||
        state.acceptance.acceptedHeadSha !== null ||
        state.acceptance.waivedHeadSha !== null ||
        state.acceptance.waiverReason !== null ||
        state.acceptance.publication.history.length > 0 ||
        state.acceptance.publication.orphanedStandalones.length > 0 ||
        state.acceptance.publication.pendingAttempt !== null ||
        state.handoffReport !== null ||
        state.finalization !== null ||
        state.resourceCleanup !== null
    ) {
        throw new Error(
            'Review head reconciliation cannot amend a round consumed by later evidence',
        );
    }
    return {
        actualHeadSha: input.actualHeadSha,
        correctedRange: `${parent.headSha}..${input.actualHeadSha}`,
        original: structuredClone(latest),
    };
}

export function applyLatestReviewHeadReconciliation(
    state: ReviewHeadReconciliationContext,
    reconciliation: ReviewHeadReconciliation,
): void {
    const latest = state.reviewGate.rounds.at(-1);
    if (
        !latest ||
        JSON.stringify(latest) !== JSON.stringify(reconciliation.original) ||
        state.reviewGate.frozenHeadSha !== reconciliation.original.headSha
    ) {
        throw new Error('Review round changed before head reconciliation could be applied');
    }
    latest.headSha = reconciliation.actualHeadSha;
    latest.reviewedRange = reconciliation.correctedRange;
    state.reviewGate.frozenHeadSha = reconciliation.actualHeadSha;
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
    let platformGateReceipt: z.infer<typeof platformGateReceiptSchema> | null = null;
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
        if (input.mode === 'full') {
            platformGateReceipt = assertCanonicalPlatformNeutralGate(
                state,
                input.headSha,
                input.ciReceipt,
            );
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
            input.parentReviewId !== parent.id
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
        platformGateReceipt,
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

export function assertReviewHeadFrozen(state: ReviewHeadContext, headSha?: string): void {
    if (!state.reviewGate.frozenHeadSha) {
        throw new Error('Delivery requires an explicitly frozen review-clean head');
    }
    if (headSha && state.reviewGate.frozenHeadSha !== headSha) {
        throw new Error(
            'Delivery requires the exact current PR head to be review-clean and frozen',
        );
    }
}
