import { publishAcceptanceRound, recordOrphanedAcceptance } from './acceptance-publication';
import {
    admitCiFallback,
    ciFailureKindSchema,
    ciFallbackResultSchema,
    recordCiFallbackResult,
} from './ci-fallback';
import {
    formatFinalizationSummary,
    generateFinalization,
    recordFinalizationDelivery,
} from './finalization';
import { generateHandoffReport, recordHandoffDelivery } from './handoff-report';
import {
    assessExpectationDrift,
    driftKindSchema,
    materialDriftKindSchema,
    nonMaterialDriftKindSchema,
    publishExpectationDriftComment,
    publishExpectationDriftViaGh,
} from './issue-drift';
import {
    acquireMutationLease,
    mutationLeaseKindSchema,
    releaseMutationLease,
} from './mutation-lease';
import { createResumeCheckpoint, formatResumeCheckpoint } from './resume';
import {
    overrideReviewPolicy,
    recordReviewDecision,
    reviewModeSchema,
    reviewPolicyModeSchema,
} from './review-gate';
import {
    checkpointBoundarySchema,
    enrichIssueCheckpoint,
    recordCostCheckpoint,
    routeWorkflowWork,
} from './run-budget';
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
import { completeValidation, startValidation, validationKindSchema } from './validation-gate';
import {
    assertCleanValidationStart,
    inspectWorktreeDelta,
    inspectWorktreeIntegrity,
} from './worktree-integrity';

type OptionScalar = string | true;
type OptionValue = OptionScalar | OptionScalar[];
type Options = Record<string, OptionValue>;

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

function parseOptions(argv: string[]): { command: string | undefined; options: Options } {
    const [command, ...tokens] = argv;
    const options: Options = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token.startsWith('--')) throw new Error(`Expected an option, received: ${token}`);
        const key = token.slice(2);
        const next = tokens[index + 1];
        const value: OptionScalar = next && !next.startsWith('--') ? tokens[++index] : true;
        const current = options[key];
        if (current === undefined) options[key] = value;
        else if (Array.isArray(current)) current.push(value);
        else options[key] = [current, value];
    }
    return { command, options };
}

function one(options: Options, key: string, isRequired = false): string | undefined {
    const raw = options[key];
    const value = Array.isArray(raw) ? raw.at(-1) : raw;
    if (isRequired && [undefined, true, ''].includes(value)) {
        throw new Error(`Missing --${key}`);
    }
    return typeof value === 'string' ? value : undefined;
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

const COMMAND_USAGE: Record<string, string> = {
    'acceptance':
        'acceptance --state PATH [--status STATUS] [--id ID] [--url URL] [--round N] [--accepted-head-sha SHA] [--waived-head-sha SHA --waiver-reason TEXT]',
    'acceptance-orphan':
        'acceptance-orphan --state PATH --acceptance-id ID --reason TEXT [--verify-run-id ID]',
    'acceptance-publish': 'acceptance-publish --state PATH --report-dir DIR --head-sha SHA',
    'checkpoint':
        'checkpoint --state PATH [--boundary manual|issue|batch|phase] [--issue-number N] [--tokens N|unavailable] [--commit-count N|unavailable] [--file-count N|unavailable] [--revised-eta TEXT]',
    'ci-fallback-admit':
        'ci-fallback-admit --state PATH --failure-kind KIND --failure-detail TEXT --failure-job NAME --failure-url URL --head-sha SHA [--verified-zero-steps] [--authorization TEXT]',
    'ci-fallback-result':
        'ci-fallback-result --state PATH --head-sha SHA --platform-command COMMAND --platform-result RESULT --e2e-command COMMAND --e2e-result RESULT',
    'drift-assess':
        'drift-assess --state PATH --number N --head-sha SHA --kind KIND --drift-key KEY [--expectation TEXT --evidence TEXT --decision TEXT --acceptance-impact TEXT] [--decision-required]',
    'drift-comment': 'drift-comment --state PATH --number N --record-id ID',
    'finalization-delivered': 'finalization-delivered --state PATH',
    'finalization-generate':
        'finalization-generate --state PATH --head-sha SHA --merge-sha SHA --issue NUMBER:CLOSED:Done',
    'init': 'init --objective TEXT [--run-id ID] [--branch NAME] [--worktree-path PATH --main-checkout-path PATH --base-sha SHA]',
    'issue':
        'issue --state PATH --number N [--title TEXT] [--status STATUS] [--check ID] [--commit SHA] [--dependency N] [--priority TEXT] [--validation ID]',
    'mutation-acquire': 'mutation-acquire --state PATH --kind repair --holder-id ID',
    'mutation-release': 'mutation-release --state PATH --kind repair --holder-id ID',
    'note': 'note --state PATH --kind KIND --text TEXT',
    'notes': 'notes --state PATH [--json]',
    'phase': 'phase --state PATH --phase NAME [--reason TEXT]',
    'pr': 'pr --state PATH [--number N] [--url URL] [--status STATUS] [--head-sha SHA] [--branch NAME]',
    'report-delivered': 'report-delivered --state PATH --head-sha SHA [--acceptance-url URL]',
    'report-generate': 'report-generate --state PATH --head-sha SHA',
    'resume': 'resume --state PATH [--json]',
    'review':
        'review --state PATH --head-sha SHA --mode full|quick|light --p0 N --p1 N --scope TEXT --reviewed-range RANGE [--baseline-review-id ID] [--baseline-head-sha SHA] [--parent-review-id ID] [--freeze]',
    'review-policy': 'review-policy --state PATH --mode full-once|quick|light --source TEXT',
    'scope-admit': 'scope-admit --state PATH --title TEXT [--blocking]',
    'show': 'show --state PATH',
    'validate': 'validate --state PATH',
    'validation-complete': 'validation-complete --state PATH --id ID --exit-code N',
    'validation-start':
        'validation-start --state PATH --kind KIND --lineage-id ID [--head-sha EXPECTED_SHA] --command COMMAND --session-id ID --log-path PATH',
    'worktree':
        'worktree --state PATH --worktree-path PATH --main-checkout-path PATH --base-sha SHA [--branch NAME]',
};

const COMMAND_VALUES: Partial<Record<string, string[]>> = {
    'acceptance': [`status: ${acceptanceStatusSchema.options.join('|')}`],
    'ci-fallback-admit': [`failure-kind: ${ciFailureKindSchema.options.join('|')}`],
    'drift-assess': [
        `kind: ${[...materialDriftKindSchema.options, ...nonMaterialDriftKindSchema.options].join('|')}`,
    ],
    'issue': [`status: ${issueStatusSchema.options.join('|')}`],
    'mutation-acquire': [`kind: ${mutationLeaseKindSchema.options.join('|')}`],
    'mutation-release': [`kind: ${mutationLeaseKindSchema.options.join('|')}`],
    'note': [`kind: ${noteKindSchema.options.join('|')}`],
    'phase': [`phase: ${phaseSchema.options.join('|')}`],
    'pr': [`status: ${pullRequestStatusSchema.options.join('|')}`],
    'review': [`mode: ${reviewModeSchema.options.join('|')}`],
    'review-policy': [`mode: ${reviewPolicyModeSchema.options.join('|')}`],
    'validation-start': [`kind: ${validationKindSchema.options.join('|')}`],
};

export function stateCliHelp(command?: string): string {
    if (!command) {
        return `Go run-state ledger

Usage:
  bun run .agents/skills/go/scripts/state.ts help <command>

Commands:
${Object.keys(COMMAND_USAGE)
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => `  ${name}`)
    .join('\n')}`;
    }
    const usage = COMMAND_USAGE[command];
    if (!usage) throw new Error(`Unknown Go state command: ${command}`);
    const values = COMMAND_VALUES[command];
    return `Go run-state ledger

Usage:
  bun run .agents/skills/go/scripts/state.ts ${usage}${values ? `\n\nAllowed values:\n${values.map((value) => `  ${value}`).join('\n')}` : ''}`;
}

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

export async function runStateCli(argv: string[]): Promise<void> {
    if (argv[0] === 'help') {
        if (argv.length > 2) throw new Error('Usage: state.ts help <command>');
        console.log(stateCliHelp(argv[1]));
        return;
    }
    const { command, options } = parseOptions(argv);
    if (!command || command === '--help' || options.help) {
        console.log(stateCliHelp(command === '--help' ? undefined : command));
        return;
    }
    if (command === 'init') return initialize(options);
    const supplied = one(options, 'state', true)!;
    const path = await resolveStatePath(supplied);
    return withStateLock(path, async () => {
        const state = await readState(path);
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
        let commandOutput: string | undefined;

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
                recordReviewDecision(state, {
                    baselineHeadSha: one(options, 'baseline-head-sha'),
                    baselineReviewId: one(options, 'baseline-review-id'),
                    freeze: options.freeze === true,
                    headSha: one(options, 'head-sha', true)!,
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
            case 'validation-start': {
                if (!state.worktree) throw new Error('Validation requires a recorded Go worktree');
                const integrity = await inspectWorktreeIntegrity(state.worktree.path);
                assertCleanValidationStart(integrity, one(options, 'head-sha'));
                const validation = startValidation(state, {
                    command: one(options, 'command', true)!,
                    headSha: integrity.headSha,
                    kind: validationKindSchema.parse(one(options, 'kind', true)),
                    lineageId: one(options, 'lineage-id', true)!,
                    logPath: one(options, 'log-path', true)!,
                    sessionId: one(options, 'session-id', true)!,
                    sourceFingerprint: integrity.sourceFingerprint,
                });
                addEvent(state, 'validation', `${validation.id} -> pending`);

                break;
            }
            case 'validation-complete': {
                if (!state.worktree) throw new Error('Validation requires a recorded Go worktree');
                const integrity = await inspectWorktreeIntegrity(state.worktree.path);
                const validation = completeValidation(state, {
                    clean: integrity.clean,
                    exitCode: integer(options, 'exit-code', true)!,
                    headSha: integrity.headSha,
                    id: one(options, 'id', true)!,
                    sourceFingerprint: integrity.sourceFingerprint,
                });
                addEvent(state, 'validation', `${validation.id} -> ${validation.result}`);

                break;
            }
            case 'mutation-acquire': {
                const kind = mutationLeaseKindSchema.parse(one(options, 'kind', true));
                if (kind !== 'repair') {
                    throw new Error('Validation leases are acquired only by validation-start');
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
                    throw new Error('Validation leases are released only by validation-complete');
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
                const status = one(options, 'status');
                recordAcceptance(state, {
                    acceptedHeadSha: one(options, 'accepted-head-sha'),
                    id: one(options, 'id'),
                    round: integer(options, 'round'),
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
        await writeState(path, state);
        if (commandOutput) console.log(commandOutput);
        else if (command !== 'scope-admit')
            console.log(path.startsWith(PROJECT_ROOT) ? path : supplied);
    });
}
