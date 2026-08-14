import { createEmptyCiFallback, createEmptyValidationBudget } from './ci-fallback';
import { createEmptyAcceptancePublication } from './acceptance-publication';
import { createEmptyReviewGate, createReviewPolicy } from './review-gate';
import {
    createEmptyIssueExpectationDrift,
    createImportedIssueExpectationDrift,
} from './issue-drift';
import { createRunBudget } from './run-budget';
import { createEmptyLedgerRetention } from './ledger-retention';
import { sanitizeLedgerDetail, sanitizeNoteText } from './note-safety';

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
            const targetPhase = /^[a-z_]+ -> ([a-z_]+)/u.exec(event.detail)?.[1];
            activeReviewPhase =
                targetPhase === 'deep_review' || targetPhase === 'delivery'
                    ? targetPhase
                    : undefined;
        } else if (event.type === 'review' && activeReviewPhase) {
            const headSha = / review for ([^:]+):/u.exec(event.detail)?.[1];
            if (headSha) reviewPhaseByHead.set(headSha, activeReviewPhase);
        }
    }
    const migratedRounds = rounds.map((decision) => {
        if (!isRecord(decision)) return decision;
        if (decision.phase === 'deep_review' || decision.phase === 'delivery') return decision;
        const headSha = typeof decision.headSha === 'string' ? decision.headSha : '';
        return { ...decision, phase: reviewPhaseByHead.get(headSha) ?? 'unknown' };
    });
    return { ...state, reviewGate: { ...reviewGate, rounds: migratedRounds }, schemaVersion: 5 };
}

function migrateV5(state: Record<string, unknown>): Record<string, unknown> {
    const legacyGate = isRecord(state.reviewGate) ? state.reviewGate : {};
    const legacyRounds = Array.isArray(legacyGate.rounds) ? legacyGate.rounds.filter(isRecord) : [];
    const reviewRounds: Record<string, unknown>[] = [];
    const validations: Record<string, unknown>[] = [];
    let baseline: Record<string, unknown> | undefined;
    let parent: Record<string, unknown> | undefined;
    for (const decision of legacyRounds) {
        const headSha = typeof decision.headSha === 'string' ? decision.headSha : 'legacy-head';
        const mode = typeof decision.mode === 'string' ? decision.mode : 'full';
        const completedAt =
            typeof decision.completedAt === 'string' ? decision.completedAt : 'legacy';
        const scope = typeof decision.scope === 'string' ? decision.scope : 'Legacy review';
        if (mode === 'verification') {
            validations.push({
                attempt: validations.length + 1,
                command: `legacy verification: ${scope}`,
                completedAt,
                exitCode: 0,
                headSha,
                id: `validation-${String(validations.length + 1).padStart(3, '0')}`,
                kind: 'evidence',
                lineageId: 'legacy-review-verification',
                logPath: 'validation/legacy-unavailable.log',
                result: 'passed',
                sessionId: 'legacy-unavailable',
                startedAt: completedAt,
            });
            continue;
        }
        const id = `review-${String(reviewRounds.length + 1).padStart(3, '0')}`;
        const importedAdditionalFull = Boolean(baseline) && mode === 'full';
        const migrated = {
            baselineHeadSha: baseline ? baseline.headSha : null,
            baselineReviewId: baseline ? baseline.id : null,
            completedAt,
            headSha,
            id,
            legacyMode: mode === 'targeted' ? 'targeted' : importedAdditionalFull ? 'full' : null,
            mode: mode === 'targeted' || importedAdditionalFull ? 'light' : 'full',
            parentReviewId: parent ? parent.id : null,
            phase:
                decision.phase === 'deep_review' || decision.phase === 'delivery'
                    ? decision.phase
                    : 'unknown',
            productP0: typeof decision.productP0 === 'number' ? decision.productP0 : 0,
            productP1: typeof decision.productP1 === 'number' ? decision.productP1 : 0,
            reviewedRange: parent ? `${String(parent.headSha)}..${headSha}` : `legacy:${scope}`,
            scope,
        };
        reviewRounds.push(migrated);
        baseline ??= migrated;
        parent = migrated;
    }
    const acceptance = isRecord(state.acceptance) ? state.acceptance : {};
    const legacyPhase = typeof state.phase === 'string' ? state.phase : 'intake';
    const phase =
        legacyPhase === 'waiting_acceptance'
            ? 'acceptance_handoff'
            : ['self_improvement', 'reporting', 'complete'].includes(legacyPhase)
              ? 'finalization'
              : legacyPhase;
    const status =
        phase === 'intake' || phase === 'planning'
            ? 'planning'
            : phase === 'waiting_acceptance'
              ? 'waiting_acceptance'
              : 'active';
    return {
        ...state,
        acceptance: { ...acceptance, waivedHeadSha: null, waiverReason: null },
        finalization: null,
        handoffReport: null,
        phase,
        reviewGate: {
            baselineReviewId: baseline?.id ?? null,
            frozenHeadSha:
                typeof legacyGate.frozenHeadSha === 'string' ? legacyGate.frozenHeadSha : null,
            rounds: reviewRounds,
        },
        reviewPolicy: createReviewPolicy('full-once', 'Imported pre-v6 policy'),
        runBudget: createRunBudget(),
        schemaVersion: 6,
        status,
        validations,
        worktree: null,
    };
}

function migrateV6(state: Record<string, unknown>): Record<string, unknown> {
    const legacyIssues: unknown[] = Array.isArray(state.issues) ? state.issues : [];
    const issues = legacyIssues.map((issue) =>
        isRecord(issue) && !('expectationDrift' in issue)
            ? {
                  ...issue,
                  expectationDrift:
                      issue.status === 'complete' || issue.status === 'deferred'
                          ? createImportedIssueExpectationDrift()
                          : createEmptyIssueExpectationDrift(),
              }
            : issue,
    );
    const handoffReport = isRecord(state.handoffReport) ? state.handoffReport : null;
    const reportNeedsRegeneration = handoffReport !== null && !('evidence' in handoffReport);
    const legacyPhase = typeof state.phase === 'string' ? state.phase : 'intake';
    return {
        ...state,
        handoffReport: reportNeedsRegeneration ? null : state.handoffReport,
        issues,
        phase: reportNeedsRegeneration && legacyPhase === 'complete' ? 'finalization' : legacyPhase,
        schemaVersion: 7,
        status: reportNeedsRegeneration && legacyPhase === 'complete' ? 'active' : state.status,
    };
}

function migrateV7(state: Record<string, unknown>): Record<string, unknown> {
    const acceptance = isRecord(state.acceptance) ? state.acceptance : {};
    const pullRequest = isRecord(state.pullRequest) ? state.pullRequest : {};
    const publication = createEmptyAcceptancePublication();
    if (
        typeof acceptance.id === 'string' &&
        acceptance.id &&
        typeof acceptance.round === 'number' &&
        acceptance.round > 0
    ) {
        publication.history.push({
            acceptanceId: acceptance.id,
            checkIds: [],
            headSha:
                typeof pullRequest.headSha === 'string'
                    ? pullRequest.headSha
                    : 'legacy-unavailable',
            publishedAt: typeof state.updatedAt === 'string' ? state.updatedAt : 'legacy',
            roundIndex: acceptance.round,
            url:
                typeof acceptance.url === 'string'
                    ? acceptance.url
                    : `https://app.lobehub.com/acceptance/${acceptance.id}`,
            verdict: 'legacy-unavailable',
            verifyRunId: 'legacy-unavailable',
        });
    }
    return {
        ...state,
        acceptance: { ...acceptance, publication },
        schemaVersion: 8,
    };
}

function migrateV8(state: Record<string, unknown>): Record<string, unknown> {
    const legacyNotes = isRecord(state.notes) ? state.notes : {};
    const notes = Object.fromEntries(
        (['technical_debt', 'token_waste', 'workflow'] as const).map((kind) => [
            kind,
            (Array.isArray(legacyNotes[kind]) ? legacyNotes[kind] : []).map((note) => {
                const record = isRecord(note) ? note : {};
                const safe = sanitizeNoteText(
                    typeof record.text === 'string' ? record.text : 'Legacy note unavailable',
                    true,
                );
                return {
                    at: typeof record.at === 'string' ? record.at : 'legacy',
                    kind,
                    ...safe,
                };
            }),
        ]),
    );
    const events: unknown[] = (Array.isArray(state.events) ? state.events : []).map(
        (event: unknown): unknown =>
            isRecord(event) && typeof event.detail === 'string'
                ? { ...event, detail: sanitizeLedgerDetail(event.detail) }
                : event,
    );
    return {
        ...state,
        events,
        notes,
        retention: createEmptyLedgerRetention(),
        schemaVersion: 9,
    };
}

function migrateV9(state: Record<string, unknown>): Record<string, unknown> {
    const legacyBudget = isRecord(state.runBudget) ? state.runBudget : {};
    const currentBudget = createRunBudget();
    const createdAt = typeof state.createdAt === 'string' ? Date.parse(state.createdAt) : 0;
    const validationAttemptCount = Array.isArray(state.validations) ? state.validations.length : 0;
    const checkpoints: Record<string, unknown>[] = (
        Array.isArray(legacyBudget.checkpoints) ? legacyBudget.checkpoints.filter(isRecord) : []
    ).map((checkpoint) => {
        const recordedAt =
            typeof checkpoint.recordedAt === 'string' ? checkpoint.recordedAt : 'legacy';
        const computedElapsed = Date.parse(recordedAt) - createdAt;
        const tokens = typeof checkpoint.tokens === 'number' ? checkpoint.tokens : 'unavailable';
        return {
            ...checkpoint,
            boundary: 'phase',
            elapsedSeconds:
                typeof checkpoint.elapsedSeconds === 'number'
                    ? checkpoint.elapsedSeconds
                    : Number.isFinite(computedElapsed) && computedElapsed >= 0
                      ? Math.floor(computedElapsed / 1_000)
                      : 0,
            headSha: null,
            issueNumber: null,
            reviewFindingCount: 0,
            tokenTelemetry: tokens === 'unavailable' ? 'degraded' : 'available',
            tokens,
            validationAttemptCount,
        };
    });
    const policy = isRecord(legacyBudget.policy) ? legacyBudget.policy : currentBudget.policy;
    const routedWork = Array.isArray(legacyBudget.routedWork) ? legacyBudget.routedWork : [];
    const threshold = checkpoints.find((checkpoint) => checkpoint.hardThresholdReached === true);
    const pendingValidation = (Array.isArray(state.validations) ? state.validations : [])
        .filter(isRecord)
        .find((validation) => validation.result === 'pending');
    return {
        ...state,
        mutationLease:
            pendingValidation && typeof pendingValidation.id === 'string'
                ? {
                      acquiredAt:
                          typeof pendingValidation.startedAt === 'string'
                              ? pendingValidation.startedAt
                              : 'legacy',
                      holderId: pendingValidation.id,
                      kind: 'validation',
                  }
                : null,
        runBudget: {
            checkpoints,
            containment: threshold
                ? {
                      activatedAt: threshold.recordedAt,
                      active: true,
                      droppedWork: ['optional_proof', 'p2_p3_expansion', 'discretionary_probes'],
                      reason: 'Imported hard budget threshold containment',
                      revisedEta: 'Re-estimate at the next safe issue boundary',
                  }
                : null,
            policy,
            policyFrozenAt: state.phase === 'intake' ? null : state.createdAt,
            repairStops: [],
            routedWork,
        },
        schemaVersion: 10,
    };
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
        const headSha = typeof pullRequest.headSha === 'string' ? pullRequest.headSha : null;
        migrated = {
            ...migrated,
            ciFallback: beyondDelivery ? migrated.ciFallback : createEmptyCiFallback(),
            reviewGate: {
                ...createEmptyReviewGate(),
                frozenHeadSha: beyondDelivery ? headSha : null,
                rounds:
                    headSha && (phase === 'delivery' || beyondDelivery)
                        ? [
                              {
                                  completedAt:
                                      typeof migrated.updatedAt === 'string'
                                          ? migrated.updatedAt
                                          : 'legacy',
                                  headSha,
                                  mode: 'full',
                                  productP0: 0,
                                  productP1: 0,
                                  scope: 'Imported pre-v4 aggregate review baseline',
                              },
                          ]
                        : [],
            },
            schemaVersion: 4,
            validationBudget: createEmptyValidationBudget(),
        };
    }
    if (migrated.schemaVersion === 4 && schemaVersion >= 5) {
        migrated = migrateReviewDecisionPhases(migrated);
    }
    if (migrated.schemaVersion === 5 && schemaVersion >= 6) migrated = migrateV5(migrated);
    if (migrated.schemaVersion === 6 && schemaVersion >= 7) migrated = migrateV6(migrated);
    if (migrated.schemaVersion === 7 && schemaVersion >= 8) migrated = migrateV7(migrated);
    if (migrated.schemaVersion === 8 && schemaVersion >= 9) migrated = migrateV8(migrated);
    if (migrated.schemaVersion === 9 && schemaVersion >= 10) migrated = migrateV9(migrated);
    return migrated;
}
