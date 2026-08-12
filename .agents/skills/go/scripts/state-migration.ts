import { createEmptyCiFallback, createEmptyValidationBudget } from './ci-fallback';
import { createEmptyReviewGate } from './review-gate';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function migrateReviewDecisionPhases(state: Record<string, unknown>): Record<string, unknown> {
    const reviewGate = isRecord(state.reviewGate) ? state.reviewGate : {};
    const rounds: unknown[] = Array.isArray(reviewGate.rounds) ? reviewGate.rounds : [];
    const events: unknown[] = Array.isArray(state.events) ? state.events : [];
    const reviewPhaseByHead = new Map<string, 'deep_review' | 'delivery'>();
    let activeReviewPhase: 'deep_review' | 'delivery' | undefined;
    for (const event of events) {
        if (!isRecord(event) || typeof event.detail !== 'string') continue;
        if (event.type === 'phase') {
            const targetPhase = /^[a-z_]+ -> ([a-z_]+)/.exec(event.detail)?.[1];
            activeReviewPhase =
                targetPhase === 'deep_review' || targetPhase === 'delivery'
                    ? targetPhase
                    : undefined;
        } else if (event.type === 'review' && activeReviewPhase) {
            const headSha = / review for ([^:]+):/.exec(event.detail)?.[1];
            if (headSha) reviewPhaseByHead.set(headSha, activeReviewPhase);
        }
    }
    const migratedRounds = rounds.map((decision) => {
        if (!isRecord(decision)) return decision;
        if (decision.phase === 'deep_review' || decision.phase === 'delivery') return decision;
        const headSha = typeof decision.headSha === 'string' ? decision.headSha : '';
        const phase = reviewPhaseByHead.get(headSha) ?? 'unknown';
        return { ...decision, phase };
    });
    return { ...state, reviewGate: { ...reviewGate, rounds: migratedRounds }, schemaVersion: 5 };
}

export function migrateState(state: unknown, schemaVersion: number): unknown {
    if (!isRecord(state)) return state;
    let migrated = state;
    if (migrated.schemaVersion === 2 && !('ciFallback' in migrated)) {
        migrated = { ...migrated, ciFallback: createEmptyCiFallback(), schemaVersion: 3 };
    }
    if (migrated.schemaVersion === 3) {
        const phase = typeof migrated.phase === 'string' ? migrated.phase : '';
        const beyondDelivery = ![
            'intake',
            'planning',
            'issue_execution',
            'deep_review',
            'delivery',
        ].includes(phase);
        const pullRequest = isRecord(migrated.pullRequest) ? migrated.pullRequest : {};
        const currentHeadSha = typeof pullRequest.headSha === 'string' ? pullRequest.headSha : null;
        const frozenHeadSha =
            beyondDelivery && typeof pullRequest.headSha === 'string' ? pullRequest.headSha : null;
        const importedReviewRounds =
            currentHeadSha && (phase === 'delivery' || beyondDelivery)
                ? [
                      {
                          completedAt:
                              typeof migrated.updatedAt === 'string'
                                  ? migrated.updatedAt
                                  : 'legacy',
                          headSha: currentHeadSha,
                          mode: 'full' as const,
                          productP0: 0,
                          productP1: 0,
                          scope: beyondDelivery
                              ? 'Imported pre-v4 accepted delivery baseline'
                              : 'Imported pre-v4 aggregate review baseline; exact-head freeze not imported',
                      },
                  ]
                : [];

        migrated = {
            ...migrated,
            ciFallback: beyondDelivery ? migrated.ciFallback : createEmptyCiFallback(),
            reviewGate: {
                ...createEmptyReviewGate(),
                frozenHeadSha,
                rounds: importedReviewRounds,
            },
            schemaVersion: 4,
            validationBudget: createEmptyValidationBudget(),
        };
    }
    if (migrated.schemaVersion === 4 && schemaVersion >= 5) {
        migrated = migrateReviewDecisionPhases(migrated);
    }
    return migrated;
}
