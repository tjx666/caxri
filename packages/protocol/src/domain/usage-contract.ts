import { z } from 'zod';

import { agentProviderIds } from '../agent/agents.js';
import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './identifiers.js';

/**
 * Selectable report windows. Each preset ends today in the requested time zone (`today` is that day alone, `all` has no
 * lower bound); `custom` spans the request's own `start` through `end`.
 */
export const usageRangeIds = ['today', '7d', '30d', '90d', '365d', 'all', 'custom'] as const;
export type UsageRange = (typeof usageRangeIds)[number];

/**
 * Which Agent Sessions a report counts: `caxri` only those Caxri Sessions hosted (the usage ledger), `all` every Agent
 * transcript on this machine, including conversations run outside Caxri.
 */
export const usageScopeIds = ['caxri', 'all'] as const;
export type UsageScope = (typeof usageScopeIds)[number];

const usagePullRequestStateSchema = z.enum(['open', 'merged', 'closed', 'missing']);
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

export const usageReportParametersSchema = z
    .object({
        /**
         * IANA zone the Client renders in; day boundaries, the heatmap, and hour-of-day use it.
         */
        timeZone: z.string().min(1).max(64),
        range: z.enum(usageRangeIds),
        /**
         * First and last local day of a `custom` range, both inclusive; required by `custom` and rejected otherwise.
         */
        start: localDate.optional(),
        end: localDate.optional(),
        provider: agentProvider.optional(),
        /**
         * Defaults to `caxri`.
         */
        scope: z.enum(usageScopeIds).optional(),
        /**
         * Narrows the report to the Agent Sessions one Caxri Session owns or currently hosts: those the ledger
         * attributes to it (the Session that first hosted each conversation) plus any bound to one of its Terminals
         * now, such as a conversation resumed there. Included conversations keep their owner in the per-Session rows,
         * and conversations run outside Caxri are left out whatever the scope.
         */
        sessionId: identifierSchema.optional(),
    })
    .refine(
        ({ end, range, start }) =>
            range === 'custom'
                ? start !== undefined && end !== undefined && start <= end
                : start === undefined && end === undefined,
        { message: 'A custom range needs start <= end; other ranges take neither' },
    );
export type UsageReportParameters = z.infer<typeof usageReportParametersSchema>;

const usageDaySchema = z.object({
    date: localDate,
    tokens: count,
    costUsd: usd,
    activeMs: count,
});
export type UsageDay = z.infer<typeof usageDaySchema>;

const usageWindowSchema = z.object({ costUsd: usd, tokens: count });

const usageProviderRowSchema = z.object({
    provider: agentProvider,
    costUsd: usd,
    tokens: usageTokenBreakdownSchema,
    sessions: count,
    activeMs: count,
});

const usageModelRowSchema = z.object({
    model: z.string().min(1).max(200),
    provider: agentProvider,
    costUsd: usd,
    tokens: usageTokenBreakdownSchema,
    /**
     * False when no price is known for the model; its cost counts as zero and the Client says so.
     */
    isPriced: z.boolean(),
});

const usageProjectRowSchema = z.object({
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

const usageSessionRowSchema = z.object({
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

const usagePullRequestRowSchema = z.object({
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
    /**
     * Which general plan window this is, as the provider names it (Claude Code's `five_hour` and `seven_day`, Codex's
     * primary and secondary windows of its `codex` limit). Absent for a window the provider did not name, so the usage
     * guard never mistakes a model-specific window for the account's weekly one by its length alone.
     */
    scope: z.enum(['session', 'weekly']).optional(),
});
const modelName = z.string().max(200);

/**
 * Pay-as-you-go credits the account can spend once a plan window is used up, as the provider reports them (Codex's
 * `credits`). `balance` is absent when the account is unlimited or the provider named no amount.
 */
export const usageCreditsSchema = z.object({
    unlimited: z.boolean(),
    balance: z.number().nonnegative().optional(),
    /**
     * ISO 4217 code when `balance` is money in major units (Claude Code's extra usage left this month); absent for
     * Codex's own credits, which are a count.
     */
    currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
});
export type UsageCredits = z.infer<typeof usageCreditsSchema>;

/**
 * Whether the account keeps working past its plan windows by spending credits. A reported account without a named
 * balance has credits on the provider's word.
 */
export function hasUsableCredits(credits: UsageCredits | undefined): boolean {
    if (!credits) return false;
    return credits.unlimited || credits.balance === undefined || credits.balance > 0;
}

/**
 * When the latest of the plan windows that are used up resets, or `undefined` when the provider would take a request
 * now: no window is at 100% with a later reset, or the account keeps working past its windows on credits. `window`
 * narrows the check to one general window; an unnamed window then never counts.
 */
export function usageLimitedUntil(
    limit: Pick<UsageLimit, 'credits' | 'windows'> | undefined,
    now: number,
    window?: 'session' | 'weekly',
): number | undefined {
    if (!limit || hasUsableCredits(limit.credits)) return undefined;
    let until: number | undefined;
    for (const { resetsAt, scope, usedPercent } of limit.windows) {
        if (resetsAt === undefined || usedPercent < 100 || resetsAt <= now) continue;
        if (window !== undefined && scope !== window) continue;
        until = Math.max(until ?? 0, resetsAt);
    }
    return until;
}

/**
 * The plan notices a user can dismiss (`usage.dismissNotice`): the pace reminder, which warns that a window runs out
 * before it resets, and the credits notice, shown while the weekly window is at the usage guard but the account keeps
 * working on credits.
 */
export const usageNoticeSchema = z.enum(['planPace', 'credits']);
export type UsageNotice = z.infer<typeof usageNoticeSchema>;

/**
 * Banked rate-limit resets the account holds: a Codex reset credit is a stored, one-time reset of the plan windows that
 * the user spends when they choose. `nextExpiresAt` is absent when no available credit names an expiry.
 */
const usageResetCreditsSchema = z.object({
    availableCount: count,
    nextExpiresAt: count.optional(),
});
export type UsageResetCredits = z.infer<typeof usageResetCreditsSchema>;

/**
 * Latest provider-reported plan rate-limit windows: Codex writes them into its own transcript, and a running Claude
 * Code Chat answers them when asked (its `/usage`). Account-wide, not limited to Caxri Sessions.
 */
export const usageLimitSchema = z.object({
    provider: agentProvider,
    observedAt: count,
    planType: z.string().max(64).optional(),
    /**
     * Claude Code's account rate-limit tier, e.g. `default_claude_max_5x`, which tells Max 5x from Max 20x where
     * `planType` only says `max`. Read from Claude Code's own account config; absent for Codex or when unknown.
     */
    rateLimitTier: z.string().max(64).optional(),
    windows: z.array(usageLimitWindowSchema).max(4),
    /**
     * Absent when the provider does not report credits, or reports an account without any.
     */
    credits: usageCreditsSchema.optional(),
    /**
     * Banked resets the account holds, asked of a running Codex Chat (its transcript records none). Absent when none
     * are held or the count is not known yet.
     */
    resetCredits: usageResetCreditsSchema.optional(),
    /**
     * When the user last dismissed this provider's pace reminder (`usage.dismissNotice`), from any Client. Clients hide
     * the reminder while it falls on their current local day (`isPlanPaceDismissed`).
     */
    paceDismissedAt: count.optional(),
    /**
     * When the user last dismissed this provider's credits notice (`usage.dismissNotice`), from any Client. Clients
     * hide the notice for a day after it (`weeklyCreditsNotice`).
     */
    creditsNoticeDismissedAt: count.optional(),
});
export type UsageLimit = z.infer<typeof usageLimitSchema>;

/**
 * Running totals of the conversation bound to one Agent Terminal, for the status bar. Priced by the same rules as the
 * Usage page, but over that conversation's own transcript files only (forked or resumed history included, since the
 * conversation carries it). `limit` is the newest rate-limit observation for the provider from any conversation or
 * Usage report Server Core has read, not only this one, because a plan limit is account-wide. Codex reports it in its
 * transcript; Claude Code reports it only while one of its Chats is running (see `PlanLimitRefresh`).
 */
export const agentUsageReadoutSchema = z.object({
    provider: agentProvider,
    tokens: usageTokenBreakdownSchema,
    costUsd: usd,
    models: z.array(modelName).max(64),
    unpricedModels: z.array(modelName).max(64),
    limit: usageLimitSchema.optional(),
});
export type AgentUsageReadout = z.infer<typeof agentUsageReadoutSchema>;

export const usageReportSchema = z.object({
    generatedAt: count,
    timeZone: z.string(),
    range: z.enum(usageRangeIds),
    provider: agentProvider.optional(),
    scope: z.enum(usageScopeIds),
    /**
     * Echoes the Session filter the report was narrowed to.
     */
    sessionId: identifierSchema.optional(),
    today: localDate,
    /**
     * First local day of the selected range; absent for `all`.
     */
    rangeStart: localDate.optional(),
    /**
     * Last local day of the selected range; absent when the range ends today.
     */
    rangeEnd: localDate.optional(),
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
         * Agent Sessions in Caxri Sessions whose transcript the background scan has not read yet; their usage is
         * missing or from the previous scan until it does. A first open over hundreds of transcripts, or the first open
         * after an upgrade that changes what is stored, reads them in the background instead of blocking the report.
         */
        pendingScans: count,
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

const sessionCostSchema = z.object({
    costUsd: usd,
    /**
     * True when a model the Session used has no known price, so `costUsd` undercounts.
     */
    isPartial: z.boolean(),
});
export type SessionCost = z.infer<typeof sessionCostSchema>;

export const usageMethods = {
    'usage.report': {
        ...commandPolicy('server', 'read'),
        params: usageReportParametersSchema,
        result: usageReportSchema,
    },
    /**
     * Everything one Session's Agent conversations have cost so far, attributed the way the Usage page's Session rows
     * are (to the Session that first hosted each conversation) and priced the same way. `null` while the ledger holds
     * no usage for it.
     */
    'usage.sessionCost': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: sessionCostSchema.nullable(),
    },
    /**
     * The newest plan rate-limit reading of every provider Server Core has seen, from the usage ledger and running
     * conversations, for a surface with no Agent Terminal in view. A provider with no reading yet is absent.
     */
    'usage.limits': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({}),
        result: z.array(usageLimitSchema).max(agentProviderIds.length),
    },
    /**
     * Hides one of the provider's plan notices on every Client: the pace reminder for the rest of the local day, the
     * credits notice for a day. The Server keeps the time in `app_state` and returns it on the reading
     * (`UsageLimit.paceDismissedAt`, `UsageLimit.creditsNoticeDismissedAt`), so a restart or another device does not
     * bring it back.
     */
    'usage.dismissNotice': {
        ...commandPolicy('server', 'write'),
        params: z.strictObject({ provider: agentProvider, notice: usageNoticeSchema }),
        result: z.null(),
    },
    /**
     * Null when the Terminal has no bound Agent session, its transcript is not found, or it recorded no usage yet.
     * Polled by the status bar like `terminal.agentThroughput`; each call parses only bytes appended since the last.
     */
    'terminal.agentUsage': {
        ...commandPolicy('server', 'read'),
        params: z.object({ terminalId: identifierSchema }),
        result: agentUsageReadoutSchema.nullable(),
    },
    /**
     * What one subagent of the Terminal's bound conversation billed, by the Chat task id (the tool call that spawned
     * it), priced like `terminal.agentUsage` and without `limit`. Null for a provider that keeps no per-subagent
     * transcript (Codex, Grok Build), a subagent whose transcript is not found yet, or one that recorded no usage yet.
     */
    'terminal.agentTaskUsage': {
        ...commandPolicy('server', 'read'),
        params: z.object({ terminalId: identifierSchema, taskId: z.string().min(1).max(200) }),
        result: agentUsageReadoutSchema.nullable(),
    },
} as const;
