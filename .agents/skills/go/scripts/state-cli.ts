import {
    publishAcceptanceRound,
    reconcileUnpublishedAcceptanceRound,
    recordOrphanedAcceptance,
    restartAcceptanceLineage,
} from './acceptance-publication';
import {
    admitCiFallback,
    ciFailureKindSchema,
    ciFallbackResultSchema,
    recordCiFallbackResult,
} from './ci-fallback';
import { readCiPlatformReceipt } from './ci-platform-receipt';
import {
    formatFinalizationSummary,
    generateFinalization,
    recordFinalizationDelivery,
} from './finalization';
import { generateHandoffReport, recordHandoffDelivery } from './handoff-report';
import {
    assessExpectationDrift,
    driftKindSchema,
    publishExpectationDriftComment,
    publishExpectationDriftViaGh,
} from './issue-drift';
import {
    acquireMutationLease,
    mutationLeaseKindSchema,
    releaseMutationLease,
} from './mutation-lease';
import { missingCanonicalPlatformNeutralGates } from './platform-neutral-gates';
import { resourceCleanupKindSchema } from './resource-cleanup';
import { runResourceAudit } from './resource-cleanup-run';
import { createResumeCheckpoint, formatResumeCheckpoint } from './resume';
import {
    overrideReviewPolicy,
    recordReviewDecision,
    reviewModeSchema,
    reviewPolicyModeSchema,
} from './review-gate';
import {
    assertReviewHeadMatchesWorktree,
    assertReviewHeadUnchangedBeforeWrite,
    reconcileLatestReviewHeadFromWorktree,
} from './review-head-reconciliation';
import {
    checkpointBoundarySchema,
    enrichIssueCheckpoint,
    recordCostCheckpoint,
    routeWorkflowWork,
} from './run-budget';
import { stateCliHelp } from './state-cli-help';
import type { GoState } from './state-model';
import {
    acceptanceStatusSchema,
    addEvent,
    createInitialState,
    issueStatusSchema,
    noteKindSchema,
    phaseSchema,
    pullRequestStatusSchema,
    recordAcceptance,
    recordNote,
    recordPullRequest,
    recordWorktree,
    transitionState,
    upsertIssue,
} from './state-model';
import {
    prepareRunDirectory,
    PROJECT_ROOT,
    readState,
    resolveStatePath,
    runDirectoryForStatePath,
    statePathForRunId,
    withStateLock,
    writeInitialState,
    writeState,
} from './state-storage';
import {
    assertAllValidationArtifactsAreValid,
    assertCurrentHeadArtifactsAreRecoverable,
    assertNoPendingValidation,
} from './validation-artifact-policy';
import { validationKindSchema } from './validation-gate';
import { runValidation } from './validation-run';
import { inspectWorktreeDelta } from './worktree-integrity';

type OptionScalar = string | true;
type OptionValue = OptionScalar | OptionScalar[];
// Partial (not Record<string, OptionValue>): the object starts empty and keys are only
// populated for flags actually present on argv, so an arbitrary key genuinely may be absent.
type Options = Partial<Record<string, OptionValue>>;

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/gu, '-')
        .replaceAll(/^-|-$/gu, '')
        .slice(0, 36);
}

function defaultRunId(objective: string): string {
    const timestamp = new Date()
        .toISOString()
        .replaceAll(/[-:]/gu, '')
        .replace(/\.\d{3}Z$/u, 'Z')
        .replace('T', '-');
    return `${timestamp}-${slugify(objective) || 'goal'}`;
}

function parseOptions(argv: string[]): {
    command: string | undefined;
    options: Options;
    passthrough: string[];
} {
    const [command, ...tokens] = argv;
    const options: Options = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--') return { command, options, passthrough: tokens.slice(index + 1) };
        if (!token.startsWith('--')) throw new Error(`Expected an option, received: ${token}`);
        const key = token.slice(2);
        const next = tokens[index + 1];
        const value: OptionScalar = next && !next.startsWith('--') ? tokens[++index] : true;
        const current = options[key];
        if (current === undefined) options[key] = value;
        else if (Array.isArray(current)) current.push(value);
        else options[key] = [current, value];
    }
    return { command, options, passthrough: [] };
}

function one(options: Options, key: string, isRequired = false): string | undefined {
    const raw = options[key];
    const value = Array.isArray(raw) ? raw.at(-1) : raw;
    if (isRequired && [undefined, true, ''].includes(value)) {
        throw new Error(`Missing --${key}`);
    }
    return typeof value === 'string' ? value : undefined;
}

const FULL_VALIDATION_ARTIFACT_COMMANDS = new Set([
    'acceptance',
    'acceptance-publish',
    'ci-fallback-admit',
    'ci-fallback-result',
    'finalization-delivered',
    'finalization-generate',
    'pr',
    'report-delivered',
    'report-generate',
    'review',
    'validate',
]);
const FULL_VALIDATION_ARTIFACT_PHASES = new Set([
    'acceptance',
    'acceptance_handoff',
    'complete',
    'deep_review',
    'delivery',
    'finalization',
    'merge',
    'waiting_acceptance',
]);

/**
 * Routine ledger bookkeeping checks only the newest completed log. Commands that consume delivery evidence run the
 * complete artifact audit first so an older receipt can never authorize a review, PR, Acceptance, or finalization.
 */
function requiresFullValidationArtifactAudit(command: string, options: Options): boolean {
    if (FULL_VALIDATION_ARTIFACT_COMMANDS.has(command)) return true;
    if (command === 'issue' && one(options, 'status') === 'complete') return true;
    return command === 'phase' && FULL_VALIDATION_ARTIFACT_PHASES.has(one(options, 'phase') ?? '');
}

function validationArtifactTargetHead(
    command: string,
    options: Options,
    state: GoState,
): string | undefined {
    if (command === 'issue' && one(options, 'status') === 'complete') {
        const issueNumber = integer(options, 'number');
        return (
            many(options, 'commit').at(-1) ??
            state.issues.find(({ number }) => number === issueNumber)?.commits.at(-1)
        );
    }
    if (command === 'acceptance') {
        const acceptanceHead = one(options, 'accepted-head-sha') ?? one(options, 'waived-head-sha');
        if (acceptanceHead) return acceptanceHead;
    }
    if (
        [
            'acceptance-publish',
            'ci-fallback-admit',
            'ci-fallback-result',
            'finalization-generate',
            'pr',
            'report-delivered',
            'report-generate',
            'review',
        ].includes(command)
    ) {
        const declaredHead = one(options, 'head-sha');
        if (declaredHead) return declaredHead;
    }
    return (
        state.pullRequest.headSha ??
        state.reviewGate.frozenHeadSha ??
        state.issues.flatMap(({ commits }) => commits).at(-1) ??
        state.worktree?.baseSha
    );
}

function many(options: Options, key: string): string[] {
    const raw = options[key];
    if (raw === undefined) return [];
    return (Array.isArray(raw) ? raw : [raw]).filter(
        (value): value is string => typeof value === 'string',
    );
}

function integer(options: Options, key: string, isRequired = false): number | undefined {
    const value = one(options, key, isRequired);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`--${key} must be an integer`);
    return parsed;
}

function measured(options: Options, key: string): number | 'unavailable' {
    const value = one(options, key) ?? 'unavailable';
    if (value === 'unavailable') return value;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`--${key} must be a non-negative integer or unavailable`);
    }
    return parsed;
}

export { stateCliHelp };

async function initialize(options: Options): Promise<void> {
    const objective = one(options, 'objective', true)!;
    const runId = one(options, 'run-id') ?? defaultRunId(objective);
    const path = statePathForRunId(runId);
    const worktreePath = one(options, 'worktree-path');
    const mainCheckoutPath = one(options, 'main-checkout-path');
    const baseSha = one(options, 'base-sha');
    if (!worktreePath && [worktreePath, mainCheckoutPath, baseSha].some(Boolean)) {
        throw new Error('Worktree metadata must be provided as one complete set');
    }
    const worktree = worktreePath
        ? {
              baseSha: baseSha!,
              createdAt: new Date().toISOString(),
              mainCheckoutPath: mainCheckoutPath!,
              path: worktreePath,
          }
        : null;
    if (worktree && Object.values(worktree).some((value) => !value)) {
        throw new Error('Worktree metadata must be provided as one complete set');
    }
    const state = createInitialState({
        branch: one(options, 'branch') ?? null,
        objective,
        runId,
        worktree,
    });
    await prepareRunDirectory(path);
    await writeInitialState(path, state);
    console.log(path);
}

function parseFinalIssues(values: string[]) {
    return values.map((value) => {
        const [number, state, projectStatus] = value.split(':', 3);
        const parsedNumber = Number(number);
        if (!Number.isSafeInteger(parsedNumber) || parsedNumber <= 0) {
            throw new Error(`Invalid final issue number: ${number}`);
        }
        if (state !== 'CLOSED' || projectStatus !== 'Done') {
            throw new Error(`Final issue must use NUMBER:CLOSED:Done: ${value}`);
        }
        return { number: parsedNumber, projectStatus: 'Done' as const, state: 'CLOSED' as const };
    });
}

export async function runStateCli(
    argv: string[],
    dependencies: { readCiPlatformReceipt?: typeof readCiPlatformReceipt } = {},
): Promise<number | void> {
    if (argv[0] === 'help') {
        if (argv.length > 2) throw new Error('Usage: state.ts help <command>');
        console.log(stateCliHelp(argv[1]));
        return;
    }
    const { command, options, passthrough } = parseOptions(argv);
    if (!command || command === '--help' || options.help) {
        console.log(stateCliHelp(command === '--help' ? undefined : command));
        return;
    }
    if (command === 'init') return initialize(options);
    const supplied = one(options, 'state', true)!;
    const path = await resolveStatePath(supplied);
    if (command === 'resource-audit') {
        const recovered = many(options, 'recovered').map((kind) =>
            resourceCleanupKindSchema.parse(kind),
        );
        return runResourceAudit(path, recovered);
    }
    if (command === 'validation-run') {
        await withStateLock(path, async () => {
            const state = await readState(path);
            if (!state.resourceCleanup) return;
            state.resourceCleanup = null;
            addEvent(state, 'resource_cleanup', 'Invalidated by validation-run');
            await writeState(path, state);
        });
        const [executable, ...arguments_] = passthrough;
        if (!executable) throw new Error('validation-run requires -- EXECUTABLE [ARG ...]');
        return runValidation(path, {
            arguments: arguments_,
            executable,
            expectedHeadSha: one(options, 'head-sha'),
            kind: validationKindSchema.parse(one(options, 'kind', true)),
            lineageId: one(options, 'lineage-id', true)!,
            sessionId: one(options, 'session-id'),
        });
    }
    if (passthrough.length > 0) throw new Error(`${command} does not accept arguments after --`);
    const requestedReviewHead = command === 'review' ? one(options, 'head-sha') : undefined;
    const isNeedsCiReceipt = command === 'review' && one(options, 'mode') === 'full';
    const preflightState = isNeedsCiReceipt ? await readState(path) : null;
    const ciReceipt =
        isNeedsCiReceipt &&
        requestedReviewHead &&
        preflightState &&
        missingCanonicalPlatformNeutralGates(preflightState, requestedReviewHead).length > 0
            ? await (dependencies.readCiPlatformReceipt ?? readCiPlatformReceipt)(
                  requestedReviewHead,
              )
            : null;
    return withStateLock(path, async () => {
        const requiresFullArtifactAudit = requiresFullValidationArtifactAudit(command, options);
        const state = await readState(path, {
            validationArtifacts: requiresFullArtifactAudit ? 'full' : 'metadata',
        });
        if (requiresFullArtifactAudit) {
            // Persist reconciliation before any gate throws so a damaged passed receipt can be replaced safely.
            await writeState(path, state);
            assertNoPendingValidation(state);
            if (command === 'validate') assertAllValidationArtifactsAreValid(state);
            else {
                assertCurrentHeadArtifactsAreRecoverable(
                    state,
                    validationArtifactTargetHead(command, options, state),
                );
            }
        }
        if (command === 'resume') {
            const checkpoint = createResumeCheckpoint(state);
            console.log(
                options.json
                    ? JSON.stringify(checkpoint, null, 2)
                    : formatResumeCheckpoint(checkpoint),
            );
            return;
        }
        if (command === 'show') {
            console.log(JSON.stringify(state, null, 2));
            return;
        }
        if (command === 'notes') {
            if (options.json) console.log(JSON.stringify(state.notes, null, 2));
            else {
                for (const [kind, notes] of Object.entries(state.notes)) {
                    console.log(`${kind}:`);
                    for (const note of notes) console.log(`- ${note.text}`);
                }
                if (state.retention.archive) {
                    console.log(
                        `archive: ${state.retention.archive.entryCount} entries/${state.retention.archive.byteLength} bytes, sha256=${state.retention.archive.sha256}`,
                    );
                }
            }
            return;
        }
        if (command === 'validate') {
            console.log('Go state is valid');
            return;
        }
        const shouldPreserveResourceCleanup =
            (command === 'phase' && one(options, 'phase') === 'complete') ||
            command === 'review-reconcile-head';
        if (!shouldPreserveResourceCleanup && state.resourceCleanup) {
            state.resourceCleanup = null;
            addEvent(state, 'resource_cleanup', `Invalidated by ${command}`);
        }
        let commandOutput: string | undefined;
        let reviewHeadValidation:
            Awaited<ReturnType<typeof assertReviewHeadMatchesWorktree>> | undefined;

        switch (command) {
            case 'phase': {
                transitionState(
                    state,
                    phaseSchema.parse(one(options, 'phase', true)),
                    one(options, 'reason'),
                );

                break;
            }
            case 'issue': {
                const status = one(options, 'status');
                const issueNumber = integer(options, 'number', true)!;
                const isIssueWasComplete = state.issues.some(
                    (issue) => issue.number === issueNumber && issue.status === 'complete',
                );
                const previousIssueHead = state.runBudget.checkpoints.findLast(
                    ({ boundary, headSha }) => boundary === 'issue' && headSha,
                )?.headSha;
                const delta =
                    status === 'complete' && !isIssueWasComplete && state.worktree
                        ? await inspectWorktreeDelta(
                              state.worktree.path,
                              previousIssueHead ?? state.worktree.baseSha,
                          )
                        : undefined;
                upsertIssue(state, {
                    checks: many(options, 'check'),
                    commits: many(options, 'commit'),
                    dependencies: many(options, 'dependency').map(Number),
                    number: issueNumber,
                    priority: one(options, 'priority'),
                    status: status ? issueStatusSchema.parse(status) : undefined,
                    title: one(options, 'title'),
                    validations: many(options, 'validation'),
                });
                if (delta) enrichIssueCheckpoint(state, { ...delta, issueNumber });

                break;
            }
            case 'drift-assess': {
                const kind = driftKindSchema.parse(one(options, 'kind', true));
                const assessment = assessExpectationDrift(state, {
                    acceptanceImpact: one(options, 'acceptance-impact'),
                    decision: one(options, 'decision'),
                    decisionRequired: options['decision-required'] === true,
                    driftKey: one(options, 'drift-key', true)!,
                    evidence: one(options, 'evidence'),
                    expectation: one(options, 'expectation'),
                    headSha: one(options, 'head-sha', true)!,
                    issueNumber: integer(options, 'number', true)!,
                    kind,
                });
                addEvent(
                    state,
                    'issue_drift',
                    `#${String(integer(options, 'number', true))} ${kind} -> ${assessment.record?.id ?? 'none'}`,
                );

                break;
            }
            case 'drift-comment': {
                const issueNumber = integer(options, 'number', true)!;
                const record = await publishExpectationDriftComment(
                    state,
                    { issueNumber, recordId: one(options, 'record-id', true)! },
                    publishExpectationDriftViaGh,
                );
                addEvent(
                    state,
                    'issue_drift',
                    `#${issueNumber} ${record.id} -> ${record.commentUrl}`,
                );

                break;
            }
            case 'worktree': {
                recordWorktree(state, {
                    baseSha: one(options, 'base-sha', true)!,
                    branch: one(options, 'branch'),
                    mainCheckoutPath: one(options, 'main-checkout-path', true)!,
                    path: one(options, 'worktree-path', true)!,
                });

                break;
            }
            case 'pr': {
                const status = one(options, 'status');
                recordPullRequest(state, {
                    branch: one(options, 'branch'),
                    headSha: one(options, 'head-sha'),
                    number: integer(options, 'number'),
                    status: status ? pullRequestStatusSchema.parse(status) : undefined,
                    url: one(options, 'url'),
                });

                break;
            }
            case 'review-policy': {
                overrideReviewPolicy(
                    state,
                    reviewPolicyModeSchema.parse(one(options, 'mode', true)),
                    one(options, 'source', true)!,
                );
                addEvent(
                    state,
                    'review_policy',
                    `${state.reviewPolicy.mode}: ${state.reviewPolicy.source}`,
                );

                break;
            }
            case 'review': {
                const requestedHeadSha = one(options, 'head-sha', true)!;
                reviewHeadValidation = await assertReviewHeadMatchesWorktree(
                    state,
                    requestedHeadSha,
                );
                recordReviewDecision(state, {
                    baselineHeadSha: one(options, 'baseline-head-sha'),
                    baselineReviewId: one(options, 'baseline-review-id'),
                    ciReceipt,
                    freeze: options.freeze === true,
                    headSha: reviewHeadValidation.canonicalHeadSha,
                    mode: reviewModeSchema.parse(one(options, 'mode', true)),
                    p0: integer(options, 'p0', true)!,
                    p1: integer(options, 'p1', true)!,
                    parentReviewId: one(options, 'parent-review-id'),
                    reviewedRange: one(options, 'reviewed-range', true)!,
                    scope: one(options, 'scope', true)!,
                });
                const review = state.reviewGate.rounds.at(-1)!;
                addEvent(state, 'review', `${review.id} ${review.mode} ${review.reviewedRange}`);

                break;
            }
            case 'review-reconcile-head': {
                await reconcileLatestReviewHeadFromWorktree(state, {
                    reason: one(options, 'reason', true)!,
                    reviewId: one(options, 'review-id', true)!,
                });

                break;
            }
            case 'mutation-acquire': {
                const kind = mutationLeaseKindSchema.parse(one(options, 'kind', true));
                if (kind !== 'repair') {
                    throw new Error('Validation leases are acquired only by validation-run');
                }
                const lease = acquireMutationLease(state, {
                    holderId: one(options, 'holder-id', true)!,
                    kind,
                });
                addEvent(state, 'mutation_lease', `${lease.kind}:${lease.holderId} -> acquired`);

                break;
            }
            case 'mutation-release': {
                const kind = mutationLeaseKindSchema.parse(one(options, 'kind', true));
                if (kind !== 'repair') {
                    throw new Error('Validation leases are released only by validation-run');
                }
                const holderId = one(options, 'holder-id', true)!;
                releaseMutationLease(state, { holderId, kind });
                addEvent(state, 'mutation_lease', `${kind}:${holderId} -> released`);

                break;
            }
            case 'checkpoint': {
                recordCostCheckpoint(state, {
                    boundary: checkpointBoundarySchema.parse(one(options, 'boundary') ?? 'manual'),
                    commitCount: measured(options, 'commit-count'),
                    fileCount: measured(options, 'file-count'),
                    issueNumber: integer(options, 'issue-number'),
                    revisedEta: one(options, 'revised-eta'),
                    tokens: measured(options, 'tokens'),
                });

                break;
            }
            case 'scope-admit': {
                const result = routeWorkflowWork(state, {
                    blocking: options.blocking === true,
                    title: one(options, 'title', true)!,
                });
                addEvent(state, 'scope', `${result}: ${one(options, 'title', true)}`);
                console.log(result);

                break;
            }
            case 'report-generate': {
                await generateHandoffReport(
                    state,
                    runDirectoryForStatePath(path),
                    one(options, 'head-sha', true)!,
                );

                break;
            }
            case 'report-delivered': {
                recordHandoffDelivery(state, {
                    acceptanceUrl: one(options, 'acceptance-url'),
                    headSha: one(options, 'head-sha', true)!,
                });

                break;
            }
            case 'finalization-generate': {
                const finalization = await generateFinalization(
                    state,
                    runDirectoryForStatePath(path),
                    {
                        headSha: one(options, 'head-sha', true)!,
                        issues: parseFinalIssues(many(options, 'issue')),
                        mergeSha: one(options, 'merge-sha', true)!,
                    },
                );
                commandOutput = formatFinalizationSummary(finalization);

                break;
            }
            case 'finalization-delivered': {
                const finalization = await recordFinalizationDelivery(
                    state,
                    runDirectoryForStatePath(path),
                );
                commandOutput = formatFinalizationSummary(finalization);

                break;
            }
            case 'acceptance-publish': {
                await publishAcceptanceRound(
                    state,
                    {
                        headSha: one(options, 'head-sha', true)!,
                        reportDirectory: one(options, 'report-dir', true)!,
                    },
                    undefined,
                    undefined,
                    () => writeState(path, state),
                );

                break;
            }
            case 'acceptance-orphan': {
                recordOrphanedAcceptance(state, {
                    acceptanceId: one(options, 'acceptance-id', true)!,
                    reason: one(options, 'reason', true)!,
                    verifyRunId: one(options, 'verify-run-id'),
                });

                break;
            }
            case 'acceptance-reconcile-round': {
                const reason = one(options, 'reason', true)!;
                reconcileUnpublishedAcceptanceRound(state, {
                    reason,
                    round: integer(options, 'round', true)!,
                });
                addEvent(
                    state,
                    'acceptance',
                    `Reconciled unpublished round to ${state.acceptance.round}: ${reason}`,
                );

                break;
            }
            case 'acceptance-restart-lineage': {
                restartAcceptanceLineage(state, {
                    acceptanceId: one(options, 'acceptance-id', true)!,
                    reason: one(options, 'reason', true)!,
                });
                addEvent(
                    state,
                    'acceptance',
                    `Restarted inaccessible lineage ${one(options, 'acceptance-id', true)}`,
                );

                break;
            }
            case 'ci-fallback-admit': {
                admitCiFallback(state, {
                    authorization: one(options, 'authorization'),
                    failureDetail: one(options, 'failure-detail', true)!,
                    failureJob: one(options, 'failure-job', true)!,
                    failureKind: ciFailureKindSchema.parse(one(options, 'failure-kind', true)),
                    failureRunUrl: one(options, 'failure-url', true)!,
                    headSha: one(options, 'head-sha', true)!,
                    verifiedZeroSteps: options['verified-zero-steps'] === true,
                });

                break;
            }
            case 'ci-fallback-result': {
                recordCiFallbackResult(state, {
                    electronE2eCommand: one(options, 'e2e-command', true)!,
                    electronE2eResult: ciFallbackResultSchema.parse(
                        one(options, 'e2e-result', true),
                    ),
                    headSha: one(options, 'head-sha', true)!,
                    platformCommands: many(options, 'platform-command'),
                    platformResult: ciFallbackResultSchema.parse(
                        one(options, 'platform-result', true),
                    ),
                });

                break;
            }
            case 'acceptance': {
                if (options.round !== undefined) {
                    throw new Error(
                        'state.ts acceptance cannot set --round; acceptance-publish owns round advancement',
                    );
                }
                const status = one(options, 'status');
                recordAcceptance(state, {
                    acceptedHeadSha: one(options, 'accepted-head-sha'),
                    id: one(options, 'id'),
                    status: status ? acceptanceStatusSchema.parse(status) : undefined,
                    url: one(options, 'url'),
                    waivedHeadSha: one(options, 'waived-head-sha'),
                    waiverReason: one(options, 'waiver-reason'),
                });

                break;
            }
            case 'note': {
                recordNote(state, {
                    kind: noteKindSchema.parse(one(options, 'kind', true)),
                    text: one(options, 'text', true)!,
                });

                break;
            }
            default: {
                throw new Error(`Unknown command: ${command}`);
            }
        }
        if (reviewHeadValidation) {
            await assertReviewHeadUnchangedBeforeWrite(state, reviewHeadValidation);
        }
        await writeState(path, state);
        if (commandOutput) console.log(commandOutput);
        else if (command !== 'scope-admit')
            console.log(path.startsWith(PROJECT_ROOT) ? path : supplied);
    });
}
