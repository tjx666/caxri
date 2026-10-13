import type {
    AgentLaunchSettings,
    AgentProvider,
    BenchmarkAttempt,
    BenchmarkEntry,
    BenchmarkRun,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentEnvironment } from '../agents';
import type { ModelPricing } from '../usage';
import { measureConversationUsage } from '../usage';
import type { HeadlessTurnDependencies, HeadlessTurnOutcome } from './headless-turn';
import { runHeadlessTurn } from './headless-turn';
import { buildJudgePrompt, parseJudgeReply } from './judge';
import { benchmarkLaunchSettings } from './launch';
import type { BenchmarkWorkspaces } from './workspace';
import { attemptBase } from './workspace';

/**
 * The bound on a check command, which runs after the Agent and should not need as long as the Agent itself.
 */
const MAX_CHECK_TIMEOUT_MS = 10 * 60_000;

export interface AttemptRunnerContext {
    turn: HeadlessTurnDependencies;
    workspaces: BenchmarkWorkspaces;
    agentEnvironment: AgentEnvironment;
    pricing: ModelPricing;
    logger: StructuredLogger;
    launchSettings(provider: AgentProvider): AgentLaunchSettings;
    cliVersion(provider: AgentProvider): Promise<string | undefined>;
    /**
     * Where a Project-mode run clones from; absent for an empty-folder run.
     */
    projectRoot?: string;
}

export interface AttemptObserver {
    /**
     * The Attempt advanced in memory (live steps, a status change). `isTransition` asks for a durable save too.
     */
    changed(isTransition: boolean): void;
}

const FINAL_STATUSES = new Set<BenchmarkAttempt['status']>([
    'completed',
    'failed',
    'timedOut',
    'cancelled',
]);

export function isAttemptFinished(attempt: BenchmarkAttempt): boolean {
    return FINAL_STATUSES.has(attempt.status);
}

/**
 * Runs one Attempt end to end: prepares its folder, runs the Entry's Agent on the prompt, then measures tokens and cost
 * from the transcript, the diff against the starting commit, and the check command. Mutates `attempt` in place and
 * reports every change through `observer`; never rejects.
 */
export async function runAttempt(
    context: AttemptRunnerContext,
    run: BenchmarkRun,
    attempt: BenchmarkAttempt,
    signal: AbortSignal,
    observer: AttemptObserver,
): Promise<void> {
    const entry = run.entries[attempt.entryIndex];
    const timeoutMs = run.settings.timeoutMinutes * 60_000;
    attempt.status = 'preparing';
    observer.changed(true);
    const cliVersion = await context.cliVersion(entry.provider);
    if (cliVersion) attempt.cliVersion = cliVersion.slice(0, 200);
    try {
        await context.workspaces.prepare(
            run.id,
            attempt.id,
            run.settings.workspace.kind === 'project' && context.projectRoot && run.baseCommit
                ? { kind: 'project', root: context.projectRoot, base: run.baseCommit }
                : { kind: 'empty' },
        );
    } catch {
        finish(attempt, {
            status: 'failed',
            failureReason: 'workspaceFailed',
            failureMessage: 'Caxri could not prepare the folder for this run',
        });
        observer.changed(true);
        logAttempt(context.logger, run, attempt);
        return;
    }
    if (signal.aborted) {
        finish(attempt, { status: 'cancelled' });
        observer.changed(true);
        return;
    }
    attempt.status = 'running';
    observer.changed(true);
    const cwd = context.workspaces.attemptDirectory(run.id, attempt.id);
    const outcome = await runHeadlessTurn(context.turn, {
        id: attempt.id,
        entry,
        prompt: run.prompt,
        cwd,
        launch: benchmarkLaunchSettings(entry, context.launchSettings(entry.provider)),
        timeoutMs,
        signal,
        onProgress: ({ steps, startedAt }) => {
            attempt.steps = steps;
            if (startedAt !== undefined) attempt.startedAt = startedAt;
            observer.changed(false);
        },
    });
    applyOutcome(attempt, outcome);
    await measureUsage(context, entry, attempt, cwd);
    try {
        attempt.diff = await context.workspaces.diffStat(run.id, attempt.id, attemptBase(run));
    } catch {
        // A folder the Agent broke (a removed `.git`) leaves the diff unknown rather than failing the Attempt.
    }
    // Read through a call: TypeScript keeps `signal.aborted` narrowed to `false` from the check above across the awaits.
    if (outcome.status === 'completed' && run.settings.checkCommand && !isAborted(signal)) {
        attempt.status = 'checking';
        observer.changed(true);
        attempt.check = await context.workspaces.check(
            run.id,
            attempt.id,
            run.settings.checkCommand,
            Math.min(timeoutMs, MAX_CHECK_TIMEOUT_MS),
            signal,
        );
    }
    finish(attempt, { status: outcome.status });
    observer.changed(true);
    logAttempt(context.logger, run, attempt);
}

function applyOutcome(attempt: BenchmarkAttempt, outcome: HeadlessTurnOutcome): void {
    attempt.steps = outcome.steps;
    if (outcome.startedAt !== undefined) attempt.startedAt = outcome.startedAt;
    if (outcome.durationMs !== undefined) attempt.durationMs = outcome.durationMs;
    if (outcome.finalText) attempt.finalText = outcome.finalText;
    if (outcome.agentSessionId) attempt.agentSessionId = outcome.agentSessionId.slice(0, 200);
    if (outcome.resolvedModel) attempt.resolvedModel = outcome.resolvedModel;
    if (outcome.resolvedEffort) attempt.resolvedEffort = outcome.resolvedEffort.slice(0, 40);
    if (outcome.failureReason) attempt.failureReason = outcome.failureReason;
    if (outcome.failureMessage) attempt.failureMessage = outcome.failureMessage.slice(0, 2_000);
}

async function measureUsage(
    context: AttemptRunnerContext,
    entry: BenchmarkEntry,
    attempt: BenchmarkAttempt,
    cwd: string,
): Promise<void> {
    if (!attempt.agentSessionId) return;
    try {
        await context.pricing.ensureFresh();
        const usage = await measureConversationUsage(
            context.agentEnvironment,
            (model) => context.pricing.priceOf(model),
            { provider: entry.provider, agentSessionId: attempt.agentSessionId, cwd },
        );
        if (!usage) return;
        attempt.tokens = usage.tokens;
        attempt.costSource = usage.costSource;
        if (usage.costUsd !== undefined) attempt.costUsd = usage.costUsd;
    } catch {
        // Usage stays unknown; the result shows it as such instead of zero.
    }
}

function finish(
    attempt: BenchmarkAttempt,
    result: Pick<BenchmarkAttempt, 'failureMessage' | 'failureReason' | 'status'>,
): void {
    Object.assign(attempt, result);
    attempt.finishedAt = Date.now();
}

function logAttempt(logger: StructuredLogger, run: BenchmarkRun, attempt: BenchmarkAttempt): void {
    const entry = run.entries[attempt.entryIndex];
    logger.write('info', logEventCatalog.benchmark.attemptFinished, {
        fields: {
            runId: run.id,
            attemptId: attempt.id,
            provider: entry.provider,
            model: entry.model,
            effort: entry.effort ?? null,
            status: attempt.status,
            failureReason: attempt.failureReason ?? null,
            durationMs: attempt.durationMs ?? null,
            steps: attempt.steps,
            tokens: attempt.tokens?.total ?? null,
            costSource: attempt.costSource ?? null,
        },
    });
}

/**
 * Scores every completed Attempt with the run's judge model in one blind pass. Mutates `run` in place.
 */
export async function runJudge(
    context: AttemptRunnerContext,
    run: BenchmarkRun,
    signal: AbortSignal,
    observer: AttemptObserver,
): Promise<void> {
    const judge = run.settings.judge;
    if (!judge) return;
    const completed = run.attempts.filter((attempt) => attempt.status === 'completed');
    if (completed.length === 0) {
        run.judge = {
            status: 'skipped',
            failureMessage: 'No run completed, so there was nothing to judge',
        };
        observer.changed(true);
        return;
    }
    run.judge = { status: 'running' };
    observer.changed(true);
    const startedAt = Date.now();
    const candidates = await Promise.all(
        completed.map(async (attempt) => ({
            attemptId: attempt.id,
            finalText: attempt.finalText,
            diff: await readDiff(context, run, attempt),
        })),
    );
    const { prompt, labels } = buildJudgePrompt(run.prompt, candidates);
    const judgeId = `${run.id}-judge`;
    let outcome: HeadlessTurnOutcome;
    try {
        await context.workspaces.prepare(run.id, 'judge', { kind: 'empty' });
        outcome = await runHeadlessTurn(context.turn, {
            id: judgeId,
            entry: judge,
            prompt,
            cwd: context.workspaces.attemptDirectory(run.id, 'judge'),
            launch: benchmarkLaunchSettings(judge, context.launchSettings(judge.provider)),
            timeoutMs: run.settings.timeoutMinutes * 60_000,
            signal,
        });
    } catch {
        outcome = {
            status: 'failed',
            steps: 0,
            failureMessage: 'Caxri could not prepare the judge folder',
        };
    }
    const scores = outcome.finalText ? parseJudgeReply(outcome.finalText) : undefined;
    for (const attempt of completed) {
        const score = scores?.get(labels.get(attempt.id) ?? '');
        if (score) attempt.judge = score;
    }
    const durationMs = Date.now() - startedAt;
    const cost = await judgeCost(
        context,
        judge,
        outcome,
        context.workspaces.attemptDirectory(run.id, 'judge'),
    );
    run.judge =
        scores && outcome.status === 'completed'
            ? { status: 'completed', durationMs, ...cost }
            : {
                  status: 'failed',
                  durationMs,
                  ...cost,
                  failureMessage: (outcome.status === 'completed'
                      ? 'The judge did not reply with scores'
                      : (outcome.failureMessage ?? `The judge run ended as ${outcome.status}`)
                  ).slice(0, 2_000),
              };
    observer.changed(true);
    context.logger.write('info', logEventCatalog.benchmark.judgeFinished, {
        fields: {
            runId: run.id,
            outcome:
                run.judge.status === 'completed' ? 'completed' : scores ? 'failed' : 'unparsable',
            durationMs,
        },
    });
}

async function readDiff(
    context: AttemptRunnerContext,
    run: BenchmarkRun,
    attempt: BenchmarkAttempt,
): Promise<string | undefined> {
    try {
        return (await context.workspaces.diff(run.id, attempt.id, attemptBase(run))).diff;
    } catch {
        return undefined;
    }
}

async function judgeCost(
    context: AttemptRunnerContext,
    judge: BenchmarkEntry,
    outcome: HeadlessTurnOutcome,
    cwd: string,
): Promise<{ costUsd?: number }> {
    if (!outcome.agentSessionId) return {};
    try {
        const usage = await measureConversationUsage(
            context.agentEnvironment,
            (model) => context.pricing.priceOf(model),
            { provider: judge.provider, agentSessionId: outcome.agentSessionId, cwd },
        );
        return usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd };
    } catch {
        return {};
    }
}

function isAborted(signal: AbortSignal): boolean {
    return signal.aborted;
}
