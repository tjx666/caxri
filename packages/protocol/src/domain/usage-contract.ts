import { z } from 'zod';

import { agentProviderIds } from '../agent/agents.js';
import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './domain.js';

/**
 * Selectable report windows. Each one ends today in the requested time zone; `all` has no lower bound.
 */
export const usageRangeIds = ['7d', '30d', '90d', '365d', 'all'] as const;
export type UsageRange = (typeof usageRangeIds)[number];

/**
 * Which Agent Sessions a report counts: `caxri` only those Caxri Sessions hosted (the usage ledger), `all` every Agent
 * transcript on this machine, including conversations run outside Caxri.
 */
export const usageScopeIds = ['caxri', 'all'] as const;
export type UsageScope = (typeof usageScopeIds)[number];

export const usagePullRequestStateSchema = z.enum(['open', 'merged', 'closed', 'missing']);
export type UsagePullRequestState = z.infer<typeof usagePullRequestStateSchema>;

const count = z.number().int().nonnegative();
const usd = z.number().nonnegative();
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const agentProvider = z.enum(agentProviderIds);

/**
 * `input` excludes cache reads and writes (Codex reports cached input inside `input_tokens`; the Server splits it out),
 * `output` includes reasoning, and `reasoning` is informational only. `total` is `input + output + cacheRead +
 * cacheWrite`, the same definition ccusage uses.
 */
export const usageTokenBreakdownSchema = z.object({
    input: count,
    output: count,
    cacheRead: count,
    cacheWrite: count,
    reasoning: count,
    total: count,
});
export type UsageTokenBreakdown = z.infer<typeof usageTokenBreakdownSchema>;

export const usageReportParametersSchema = z.object({
    /**
     * IANA zone the Client renders in; day boundaries, the heatmap, and hour-of-day use it.
     */
    timeZone: z.string().min(1).max(64),
    range: z.enum(usageRangeIds),
    provider: agentProvider.optional(),
    /**
     * Defaults to `caxri`.
     */
    scope: z.enum(usageScopeIds).optional(),
});
export type UsageReportParameters = z.infer<typeof usageReportParametersSchema>;

export const usageDaySchema = z.object({
    date: localDate,
    tokens: count,
    costUsd: usd,
    activeMs: count,
});
export type UsageDay = z.infer<typeof usageDaySchema>;

const usageWindowSchema = z.object({ costUsd: usd, tokens: count });

export const usageProviderRowSchema = z.object({
    provider: agentProvider,
    costUsd: usd,
    tokens: usageTokenBreakdownSchema,
    sessions: count,
    activeMs: count,
});

export const usageModelRowSchema = z.object({
    model: z.string().min(1).max(200),
    provider: agentProvider,
    costUsd: usd,
    tokens: usageTokenBreakdownSchema,
    /**
     * False when no price is known for the model; its cost counts as zero and the Client says so.
     */
    isPriced: z.boolean(),
});

export const usageProjectRowSchema = z.object({
    projectId: identifierSchema,
    title: z.string(),
    /**
     * True when the Project's metadata was removed after the usage was recorded.
     */
    isRemoved: z.boolean(),
    /**
     * The bucket for Agent Sessions run outside Caxri whose working directory is in no Project.
     */
    isOutsideCaxri: z.boolean(),
    costUsd: usd,
    tokens: count,
    sessions: count,
    activeMs: count,
    pullRequestsMerged: count,
});
export type UsageProjectRow = z.infer<typeof usageProjectRowSchema>;

export const usageSessionRowSchema = z.object({
    sessionId: identifierSchema,
    title: z.string(),
    projectTitle: z.string(),
    isArchived: z.boolean(),
    isDeleted: z.boolean(),
    /**
     * One Agent Session run outside Caxri rather than a Caxri Session; its title is the working directory's name.
     */
    isOutsideCaxri: z.boolean(),
    providers: z.array(agentProvider).max(agentProviderIds.length),
    costUsd: usd,
    tokens: count,
    activeMs: count,
    lastActivityAt: count,
    pullRequestsMerged: count,
});
export type UsageSessionRow = z.infer<typeof usageSessionRowSchema>;

export const usagePullRequestRowSchema = z.object({
    url: z.url(),
    number: z.number().int().positive(),
    repository: z.string(),
    title: z.string(),
    state: usagePullRequestStateSchema,
    mergedAt: count.optional(),
    sessionId: identifierSchema.optional(),
    additions: count,
    deletions: count,
});
export type UsagePullRequestRow = z.infer<typeof usagePullRequestRowSchema>;

const usageLimitWindowSchema = z.object({
    windowMinutes: count,
    usedPercent: z.number().min(0).max(100),
    resetsAt: count.optional(),
});
const modelName = z.string().max(200);

/**
 * Latest provider-reported rate-limit window, as the provider wrote it into its own transcript. Account-wide, not
 * limited to Caxri Sessions.
 */
export const usageLimitSchema = z.object({
    provider: agentProvider,
    observedAt: count,
    planType: z.string().max(64).optional(),
    windows: z.array(usageLimitWindowSchema).max(4),
});
export type UsageLimit = z.infer<typeof usageLimitSchema>;

export const usageReportSchema = z.object({
    generatedAt: count,
    timeZone: z.string(),
    range: z.enum(usageRangeIds),
    provider: agentProvider.optional(),
    scope: z.enum(usageScopeIds),
    today: localDate,
    /**
     * First local day of the selected range; absent for `all`.
     */
    rangeStart: localDate.optional(),
    totals: z.object({
        costUsd: usd,
        tokens: usageTokenBreakdownSchema,
        /**
         * What the cache reads would have cost at the uncached input price, minus what they cost.
         */
        cacheSavingsUsd: usd,
        activeMs: count,
        sessionsCreated: count,
        sessionsArchived: count,
        sessionsWithUsage: count,
        /**
         * Agent Sessions run outside Caxri with usage in range; always 0 for the `caxri` scope.
         */
        outsideSessionsWithUsage: count,
        pullRequestsCreated: count,
        pullRequestsMerged: count,
        linesAdded: count,
        linesDeleted: count,
    }),
    /**
     * Fixed burn windows independent of `range`, filtered by `provider`.
     */
    windows: z.object({
        today: usageWindowSchema,
        last7Days: usageWindowSchema,
        last30Days: usageWindowSchema,
    }),
    /**
     * Days with usage within the last 53 weeks, oldest first, independent of `range`. Days without usage are omitted.
     */
    activity: z.array(usageDaySchema).max(371),
    /**
     * Tokens per local hour of day within `range`.
     */
    hourOfDay: z.array(count).length(24),
    providers: z.array(usageProviderRowSchema).max(agentProviderIds.length),
    models: z.array(usageModelRowSchema).max(200),
    projects: z.array(usageProjectRowSchema).max(500),
    sessions: z.array(usageSessionRowSchema).max(200),
    /**
     * Merged pull requests within `range`, most recent first.
     */
    pullRequests: z.array(usagePullRequestRowSchema).max(50),
    limits: z.array(usageLimitSchema).max(agentProviderIds.length),
    pricing: z.object({
        source: z.enum(['remote', 'cache', 'bundled']),
        updatedAt: count.optional(),
    }),
    coverage: z.object({
        agentSessions: count,
        /**
         * Agent Sessions whose transcript was never found, so their usage is unknown.
         */
        unavailable: count,
        /**
         * Created pull requests whose GitHub outcome has not been fetched yet.
         */
        pendingPullRequests: count,
        unpricedModels: z.array(modelName).max(50),
        /**
         * Present for the `all` scope.
         */
        outsideCaxri: z
            .object({
                /**
                 * Agent transcripts found outside the usage ledger.
                 */
                agentSessions: count,
                /**
                 * Transcripts the first background scan has not read yet; their usage is missing until it does.
                 */
                pendingScans: count,
            })
            .optional(),
    }),
});
export type UsageReport = z.infer<typeof usageReportSchema>;

export const usageMethods = {
    'usage.report': {
        ...commandPolicy('server', 'read'),
        params: usageReportParametersSchema,
        result: usageReportSchema,
    },
} as const;
