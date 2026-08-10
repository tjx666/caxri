import { createEmptyCiFallback, createEmptyValidationBudget } from './ci-fallback';
import { createEmptyReviewGate } from './review-gate';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function migrateState(state: unknown, schemaVersion: number): unknown {
    if (!isRecord(state)) return state;
    let migrated = state;
    if (migrated.schemaVersion === 2 && !('ciFallback' in migrated)) {
        migrated = { ...migrated, ciFallback: createEmptyCiFallback(), schemaVersion: 3 };
    }
    if (migrated.schemaVersion !== 3) return migrated;

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
                          typeof migrated.updatedAt === 'string' ? migrated.updatedAt : 'legacy',
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

    return {
        ...migrated,
        ciFallback: beyondDelivery ? migrated.ciFallback : createEmptyCiFallback(),
        reviewGate: { ...createEmptyReviewGate(), frozenHeadSha, rounds: importedReviewRounds },
        schemaVersion,
        validationBudget: createEmptyValidationBudget(),
    };
}
