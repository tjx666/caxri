import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { usageTokenBreakdownSchema } from '../domain/usage-contract.js';
import { commandPolicy } from '../transport/method-spec.js';
import { agentChatEffortSchema, agentChatModelSchema } from './agent-chat-contract.js';
import { agentProviderIds } from './agents.js';

/**
 * A Benchmark runs one prompt against several Agent + model + effort Entries, each in its own throwaway folder, and
 * compares what they cost, how long they took, and what they produced. See `docs/benchmark.md`.
 */

export const MAX_BENCHMARK_PROMPT_LENGTH = 32_768;
export const MAX_BENCHMARK_ENTRIES = 24;
export const MAX_BENCHMARK_REPEATS = 5;
export const MAX_BENCHMARK_CONCURRENCY = 8;
export const DEFAULT_BENCHMARK_CONCURRENCY = 3;
export const MAX_BENCHMARK_TIMEOUT_MINUTES = 120;
export const DEFAULT_BENCHMARK_TIMEOUT_MINUTES = 20;
export const MAX_BENCHMARK_CHECK_COMMAND_LENGTH = 2_000;
/**
 * Bound on the final answer stored per Attempt. A longer answer keeps its beginning and says it was cut.
 */
export const MAX_BENCHMARK_FINAL_TEXT_LENGTH = 65_536;
export const MAX_BENCHMARK_LISTED_RUNS = 200;

const count = z.number().int().nonnegative();
const agentProvider = z.enum(agentProviderIds);
const modelId = z.string().trim().min(1).max(200);

/**
 * One contestant: an Agent, the model it runs, and optionally the reasoning effort. Without an effort the provider's
 * default applies and the result says so.
 */
export const benchmarkEntrySchema = z.strictObject({
    provider: agentProvider,
    model: modelId,
    effort: agentChatEffortSchema.optional(),
});
export type BenchmarkEntry = z.infer<typeof benchmarkEntrySchema>;

/**
 * Where each Attempt runs. `empty` gives every Attempt a fresh empty Git repository, for greenfield prompts. `project`
 * clones the Project's current commit into every Attempt's folder, so uncommitted changes are not included and the
 * Project itself is never touched.
 */
export const benchmarkWorkspaceSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('empty') }),
    z.strictObject({ kind: z.literal('project'), projectId: identifierSchema }),
]);
export type BenchmarkWorkspace = z.infer<typeof benchmarkWorkspaceSchema>;

export const benchmarkSettingsSchema = z.strictObject({
    workspace: benchmarkWorkspaceSchema,
    /**
     * Runs per Entry. More than one shows the spread instead of one lucky or unlucky run.
     */
    repeats: z.number().int().min(1).max(MAX_BENCHMARK_REPEATS),
    concurrency: z.number().int().min(1).max(MAX_BENCHMARK_CONCURRENCY),
    timeoutMinutes: z.number().int().min(1).max(MAX_BENCHMARK_TIMEOUT_MINUTES),
    /**
     * Shell command run in each finished Attempt's folder; exit code 0 counts as passed.
     */
    checkCommand: z.string().trim().min(1).max(MAX_BENCHMARK_CHECK_COMMAND_LENGTH).optional(),
    /**
     * Model that scores every finished Attempt from 0 to 100 without knowing which Entry produced it.
     */
    judge: benchmarkEntrySchema.optional(),
});
export type BenchmarkSettings = z.infer<typeof benchmarkSettingsSchema>;

export const benchmarkAttemptStatusIds = [
    'queued',
    'preparing',
    'running',
    'checking',
    'completed',
    'failed',
    'timedOut',
    'cancelled',
] as const;
export const benchmarkAttemptStatusSchema = z.enum(benchmarkAttemptStatusIds);
export type BenchmarkAttemptStatus = z.infer<typeof benchmarkAttemptStatusSchema>;

/**
 * Why an Attempt did not complete. `turnFailed` is the Agent reporting a failed turn (a rejected model, an API error);
 * `serverRestarted` is an Attempt Server Core stopped mid-run, since a provider process does not survive a restart.
 */
export const benchmarkFailureReasonIds = [
    'executableNotFound',
    'workspaceFailed',
    'startFailed',
    'modelUnavailable',
    'turnFailed',
    'processExited',
    'serverRestarted',
] as const;
export const benchmarkFailureReasonSchema = z.enum(benchmarkFailureReasonIds);
export type BenchmarkFailureReason = z.infer<typeof benchmarkFailureReasonSchema>;

/**
 * Where an Attempt's cost comes from: the Agent's own report (Grok Build), the API list price of the tokens it used
 * (LiteLLM's list, the same one Usage uses), or `unknown` when a model has no price. Unknown is never shown as zero.
 */
export const benchmarkCostSourceSchema = z.enum(['provider', 'listPrice', 'unknown']);
export type BenchmarkCostSource = z.infer<typeof benchmarkCostSourceSchema>;

export const benchmarkCheckResultSchema = z.strictObject({
    status: z.enum(['passed', 'failed', 'timedOut', 'error']),
    exitCode: z.number().int().optional(),
    durationMs: count,
    /**
     * The end of the command's combined output.
     */
    outputTail: z.string().max(8_192),
});
export type BenchmarkCheckResult = z.infer<typeof benchmarkCheckResultSchema>;

export const benchmarkJudgeScoreSchema = z.strictObject({
    score: z.number().min(0).max(100),
    reason: z.string().max(2_000),
});
export type BenchmarkJudgeScore = z.infer<typeof benchmarkJudgeScoreSchema>;

export const benchmarkDiffStatSchema = z.strictObject({
    files: count,
    additions: count,
    deletions: count,
});
export type BenchmarkDiffStat = z.infer<typeof benchmarkDiffStatSchema>;

export const benchmarkAttemptSchema = z.strictObject({
    id: identifierSchema,
    entryIndex: count,
    /**
     * 1-based run number within the Entry.
     */
    repeat: z.number().int().positive(),
    status: benchmarkAttemptStatusSchema,
    failureReason: benchmarkFailureReasonSchema.optional(),
    /**
     * Caxri-authored or provider-reported explanation of a failure, for the result table.
     */
    failureMessage: z.string().max(2_000).optional(),
    /**
     * The model the Agent reported using, when it differs from the requested identifier (an alias).
     */
    resolvedModel: z.string().max(200).optional(),
    /**
     * Effort the Agent reported, which is the model default when the Entry named none.
     */
    resolvedEffort: z.string().max(40).optional(),
    cliVersion: z.string().max(200).optional(),
    startedAt: count.optional(),
    finishedAt: count.optional(),
    /**
     * From the first message sent until the Agent's turn ended; excludes folder preparation and the check command.
     */
    durationMs: count.optional(),
    tokens: usageTokenBreakdownSchema.optional(),
    costUsd: z.number().nonnegative().optional(),
    costSource: benchmarkCostSourceSchema.optional(),
    /**
     * Commands, file changes, and tool calls the Agent made. Live while the Attempt runs.
     */
    steps: count,
    diff: benchmarkDiffStatSchema.optional(),
    finalText: z
        .string()
        .max(MAX_BENCHMARK_FINAL_TEXT_LENGTH + 64)
        .optional(),
    check: benchmarkCheckResultSchema.optional(),
    judge: benchmarkJudgeScoreSchema.optional(),
    agentSessionId: z.string().max(200).optional(),
});
export type BenchmarkAttempt = z.infer<typeof benchmarkAttemptSchema>;

export const benchmarkRunStatusSchema = z.enum(['running', 'completed', 'cancelled']);
export type BenchmarkRunStatus = z.infer<typeof benchmarkRunStatusSchema>;

export const benchmarkJudgeRunSchema = z.strictObject({
    status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
    failureMessage: z.string().max(2_000).optional(),
    costUsd: z.number().nonnegative().optional(),
    durationMs: count.optional(),
});
export type BenchmarkJudgeRun = z.infer<typeof benchmarkJudgeRunSchema>;

export const benchmarkRunSchema = z.strictObject({
    id: identifierSchema,
    /**
     * First line of the prompt, for the history list.
     */
    title: z.string().max(200),
    prompt: z.string().min(1).max(MAX_BENCHMARK_PROMPT_LENGTH),
    entries: z.array(benchmarkEntrySchema).min(1).max(MAX_BENCHMARK_ENTRIES),
    settings: benchmarkSettingsSchema,
    status: benchmarkRunStatusSchema,
    createdAt: count,
    finishedAt: count.optional(),
    /**
     * The Project commit every Attempt started from, in Project mode.
     */
    baseCommit: z.string().max(64).optional(),
    projectTitle: z.string().max(200).optional(),
    /**
     * Where API list prices came from and how fresh they were when the run finished.
     */
    pricing: z
        .strictObject({
            source: z.enum(['remote', 'cache', 'bundled']),
            updatedAt: count.optional(),
        })
        .optional(),
    judge: benchmarkJudgeRunSchema.optional(),
    attempts: z.array(benchmarkAttemptSchema).max(MAX_BENCHMARK_ENTRIES * MAX_BENCHMARK_REPEATS),
});
export type BenchmarkRun = z.infer<typeof benchmarkRunSchema>;

export const benchmarkRunSummarySchema = z.strictObject({
    id: identifierSchema,
    title: z.string().max(200),
    status: benchmarkRunStatusSchema,
    createdAt: count,
    finishedAt: count.optional(),
    entries: z.array(benchmarkEntrySchema).max(MAX_BENCHMARK_ENTRIES),
    attempts: count,
    completedAttempts: count,
});
export type BenchmarkRunSummary = z.infer<typeof benchmarkRunSummarySchema>;

/**
 * What one Agent offers for a Benchmark, read from a short-lived provider process. `missing` means its CLI is not
 * installed; `failed` means it is installed but did not start (signed out, an unsupported version).
 */
export const benchmarkCatalogProviderSchema = z.strictObject({
    provider: agentProvider,
    status: z.enum(['ready', 'missing', 'failed']),
    message: z.string().max(500).optional(),
    defaultModel: z.string().max(200).optional(),
    models: z.array(agentChatModelSchema).max(100),
});
export type BenchmarkCatalogProvider = z.infer<typeof benchmarkCatalogProviderSchema>;

export const benchmarkCatalogSchema = z.strictObject({
    providers: z.array(benchmarkCatalogProviderSchema).max(agentProviderIds.length),
    checkedAt: count,
});
export type BenchmarkCatalog = z.infer<typeof benchmarkCatalogSchema>;

export const benchmarkStartParametersSchema = z.strictObject({
    prompt: z.string().trim().min(1).max(MAX_BENCHMARK_PROMPT_LENGTH),
    entries: z.array(benchmarkEntrySchema).min(1).max(MAX_BENCHMARK_ENTRIES),
    settings: benchmarkSettingsSchema,
});
export type BenchmarkStartParameters = z.infer<typeof benchmarkStartParametersSchema>;

const runReference = z.strictObject({ runId: identifierSchema });

export const benchmarkMethods = {
    /**
     * Models each Agent offers. Cached for a few minutes; `refresh` asks every provider again.
     */
    'benchmark.catalog': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ refresh: z.boolean().optional() }),
        result: benchmarkCatalogSchema,
    },
    'benchmark.list': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({}),
        result: z.strictObject({
            runs: z.array(benchmarkRunSummarySchema).max(MAX_BENCHMARK_LISTED_RUNS),
        }),
    },
    'benchmark.get': {
        ...commandPolicy('server', 'read'),
        params: runReference,
        result: benchmarkRunSchema,
    },
    /**
     * The working-tree diff of one finished Attempt against its starting commit, bounded.
     */
    'benchmark.attemptDiff': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ runId: identifierSchema, attemptId: identifierSchema }),
        result: z.strictObject({ diff: z.string(), truncated: z.boolean() }),
    },
    'benchmark.start': {
        ...commandPolicy('server', 'write'),
        params: benchmarkStartParametersSchema,
        result: runReference,
    },
    /**
     * Stops every unfinished Attempt of the run, or only `attemptId`.
     */
    'benchmark.cancel': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ runId: identifierSchema, attemptId: identifierSchema.optional() }),
        result: z.null(),
    },
    /**
     * Removes the run and the folders its Attempts ran in. Cancels it first when it is still running.
     */
    'benchmark.delete': {
        ...commandPolicy('server', 'write'),
        params: runReference,
        result: z.null(),
    },
} as const;
