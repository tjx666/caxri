import {
    admitCiFallback,
    ciFallbackResultSchema,
    ciFailureKindSchema,
    recordCiFallbackResult,
} from './ci-fallback';
import { generateFinalization, recordFinalizationDelivery } from './finalization';
import { generateHandoffReport, recordHandoffDelivery } from './handoff-report';
import { createResumeCheckpoint, formatResumeCheckpoint } from './resume';
import {
    overrideReviewPolicy,
    recordReviewDecision,
    reviewModeSchema,
    reviewPolicyModeSchema,
} from './review-gate';
import { recordCostCheckpoint, routeWorkflowWork } from './run-budget';
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
    writeInitialState,
    writeState,
} from './state-storage';
import { completeValidation, startValidation, validationKindSchema } from './validation-gate';

type OptionScalar = string | true;
type OptionValue = OptionScalar | OptionScalar[];
type Options = Record<string, OptionValue>;

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-|-$/gu, '')
        .slice(0, 36);
}

function defaultRunId(objective: string): string {
    const timestamp = new Date()
        .toISOString()
        .replace(/[-:]/gu, '')
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

function one(options: Options, key: string, required = false): string | undefined {
    const raw = options[key];
    const value = Array.isArray(raw) ? raw.at(-1) : raw;
    if (required && (value === undefined || value === true || value === '')) {
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

function integer(options: Options, key: string, required = false): number | undefined {
    const value = one(options, key, required);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error(`--${key} must be an integer`);
    return parsed;
}

function measured(options: Options, key: string): number | 'unavailable' {
    const value = one(options, key) ?? 'unavailable';
    if (value === 'unavailable') return value;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--${key} must be a non-negative integer or unavailable`);
    }
    return parsed;
}

function help(): string {
    return `Go run-state ledger

Commands:
  init --objective TEXT [--run-id ID] [--branch NAME] [--worktree-path PATH]
       [--main-checkout-path PATH] [--base-sha SHA]
  worktree --state PATH --worktree-path PATH --main-checkout-path PATH --base-sha SHA
           [--branch NAME]
  phase --state PATH --phase NAME [--reason TEXT]
  issue --state PATH --number N [--title TEXT] [--status STATUS] [--check ID]
  pr --state PATH [--number N] [--url URL] [--status STATUS] [--head-sha SHA]
  review-policy --state PATH --mode full-once|quick|light --source TEXT
  review --state PATH --head-sha SHA --mode full|quick|light --p0 N --p1 N
         --scope TEXT --reviewed-range RANGE [--baseline-review-id ID]
         [--baseline-head-sha SHA] [--parent-review-id ID] [--freeze]
  validation-start --state PATH --kind KIND --lineage-id ID --head-sha SHA
         --command COMMAND --session-id ID --log-path PATH
  validation-complete --state PATH --id ID --exit-code N
  checkpoint --state PATH [--tokens N|unavailable] [--elapsed-seconds N|unavailable]
         [--commit-count N|unavailable] [--file-count N|unavailable]
  scope-admit --state PATH --title TEXT [--blocking]
  report-generate --state PATH --head-sha SHA
  report-delivered --state PATH --head-sha SHA [--acceptance-url URL]
  finalization-generate --state PATH --head-sha SHA --merge-sha SHA
         --issue NUMBER:CLOSED:Done
  finalization-delivered --state PATH
  ci-fallback-admit | ci-fallback-result | acceptance | note | notes | resume | show | validate`;
}

async function initialize(options: Options): Promise<void> {
    const objective = one(options, 'objective', true)!;
    const runId = one(options, 'run-id') ?? defaultRunId(objective);
    const path = statePathForRunId(runId);
    const worktreePath = one(options, 'worktree-path');
    const mainCheckoutPath = one(options, 'main-checkout-path');
    const baseSha = one(options, 'base-sha');
    if ([worktreePath, mainCheckoutPath, baseSha].some(Boolean) && !worktreePath) {
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
        const [number, state, projectStatus] = value.split(':');
        const parsedNumber = Number(number);
        if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) {
            throw new Error(`Invalid final issue number: ${number}`);
        }
        if (state !== 'CLOSED' || projectStatus !== 'Done') {
            throw new Error(`Final issue must use NUMBER:CLOSED:Done: ${value}`);
        }
        return { number: parsedNumber, projectStatus: 'Done' as const, state: 'CLOSED' as const };
    });
}

export async function runStateCli(argv: string[]): Promise<void> {
    const { command, options } = parseOptions(argv);
    if (!command || command === 'help' || options.help) {
        console.log(help());
        return;
    }
    if (command === 'init') return initialize(options);
    const supplied = one(options, 'state', true)!;
    const path = await resolveStatePath(supplied);
    const state = await readState(path);
    if (command === 'resume') {
        const checkpoint = createResumeCheckpoint(state);
        console.log(
            options.json ? JSON.stringify(checkpoint, null, 2) : formatResumeCheckpoint(checkpoint),
        );
        return;
    }
    if (command === 'show') {
        console.log(JSON.stringify(state, null, 2));
        return;
    }
    if (command === 'notes') {
        if (options.json) console.log(JSON.stringify(state.notes, null, 2));
        else
            for (const [kind, notes] of Object.entries(state.notes)) {
                console.log(`${kind}:`);
                for (const note of notes) console.log(`- ${note.text}`);
            }
        return;
    }
    if (command === 'validate') {
        console.log('Go state is valid');
        return;
    }

    if (command === 'phase') {
        transitionState(
            state,
            phaseSchema.parse(one(options, 'phase', true)),
            one(options, 'reason'),
        );
    } else if (command === 'issue') {
        const status = one(options, 'status');
        upsertIssue(state, {
            checks: many(options, 'check'),
            commits: many(options, 'commit'),
            dependencies: many(options, 'dependency').map(Number),
            number: integer(options, 'number', true)!,
            priority: one(options, 'priority'),
            status: status ? issueStatusSchema.parse(status) : undefined,
            title: one(options, 'title'),
            validations: many(options, 'validation'),
        });
    } else if (command === 'worktree') {
        recordWorktree(state, {
            baseSha: one(options, 'base-sha', true)!,
            branch: one(options, 'branch'),
            mainCheckoutPath: one(options, 'main-checkout-path', true)!,
            path: one(options, 'worktree-path', true)!,
        });
    } else if (command === 'pr') {
        const status = one(options, 'status');
        recordPullRequest(state, {
            branch: one(options, 'branch'),
            headSha: one(options, 'head-sha'),
            number: integer(options, 'number'),
            status: status ? pullRequestStatusSchema.parse(status) : undefined,
            url: one(options, 'url'),
        });
    } else if (command === 'review-policy') {
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
    } else if (command === 'review') {
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
    } else if (command === 'validation-start') {
        const validation = startValidation(state, {
            command: one(options, 'command', true)!,
            headSha: one(options, 'head-sha', true)!,
            kind: validationKindSchema.parse(one(options, 'kind', true)),
            lineageId: one(options, 'lineage-id', true)!,
            logPath: one(options, 'log-path', true)!,
            sessionId: one(options, 'session-id', true)!,
        });
        addEvent(state, 'validation', `${validation.id} -> pending`);
    } else if (command === 'validation-complete') {
        const validation = completeValidation(state, {
            exitCode: integer(options, 'exit-code', true)!,
            id: one(options, 'id', true)!,
        });
        addEvent(state, 'validation', `${validation.id} -> ${validation.result}`);
    } else if (command === 'checkpoint') {
        recordCostCheckpoint(state, {
            commitCount: measured(options, 'commit-count'),
            elapsedSeconds: measured(options, 'elapsed-seconds'),
            fileCount: measured(options, 'file-count'),
            tokens: measured(options, 'tokens'),
        });
    } else if (command === 'scope-admit') {
        const result = routeWorkflowWork(state, {
            blocking: options.blocking === true,
            title: one(options, 'title', true)!,
        });
        addEvent(state, 'scope', `${result}: ${one(options, 'title', true)}`);
        console.log(result);
    } else if (command === 'report-generate') {
        await generateHandoffReport(
            state,
            runDirectoryForStatePath(path),
            one(options, 'head-sha', true)!,
        );
    } else if (command === 'report-delivered') {
        recordHandoffDelivery(state, {
            acceptanceUrl: one(options, 'acceptance-url'),
            headSha: one(options, 'head-sha', true)!,
        });
    } else if (command === 'finalization-generate') {
        await generateFinalization(state, runDirectoryForStatePath(path), {
            headSha: one(options, 'head-sha', true)!,
            issues: parseFinalIssues(many(options, 'issue')),
            mergeSha: one(options, 'merge-sha', true)!,
        });
    } else if (command === 'finalization-delivered') {
        await recordFinalizationDelivery(state, runDirectoryForStatePath(path));
    } else if (command === 'ci-fallback-admit') {
        admitCiFallback(state, {
            authorization: one(options, 'authorization'),
            failureDetail: one(options, 'failure-detail', true)!,
            failureJob: one(options, 'failure-job', true)!,
            failureKind: ciFailureKindSchema.parse(one(options, 'failure-kind', true)),
            failureRunUrl: one(options, 'failure-url', true)!,
            headSha: one(options, 'head-sha', true)!,
            verifiedZeroSteps: options['verified-zero-steps'] === true,
        });
    } else if (command === 'ci-fallback-result') {
        recordCiFallbackResult(state, {
            electronE2eCommand: one(options, 'e2e-command', true)!,
            electronE2eResult: ciFallbackResultSchema.parse(one(options, 'e2e-result', true)),
            headSha: one(options, 'head-sha', true)!,
            platformCommands: many(options, 'platform-command'),
            platformResult: ciFallbackResultSchema.parse(one(options, 'platform-result', true)),
        });
    } else if (command === 'acceptance') {
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
    } else if (command === 'note') {
        recordNote(state, {
            kind: noteKindSchema.parse(one(options, 'kind', true)),
            text: one(options, 'text', true)!,
        });
    } else {
        throw new Error(`Unknown command: ${command}`);
    }
    await writeState(path, state);
    if (command !== 'scope-admit') console.log(path.startsWith(PROJECT_ROOT) ? path : supplied);
}
