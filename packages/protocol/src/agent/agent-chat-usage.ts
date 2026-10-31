import { z } from 'zod';

import type { SessionPullRequest } from '../domain/session-pull-request.js';
import type { AgentChatItem, AgentChatSnapshot } from './agent-chat-contract.js';
import { MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH } from './agent-chat-goal-contract.js';
import { agentThroughputSpeedSchema } from './agent-throughput-contract.js';
import type { AgentProvider } from './agents.js';

export const MAX_AGENT_CHAT_USAGE_BREAKDOWN = 16;

/**
 * One row of what fills the context window, such as Claude Code's "Messages" category or Codex's cached input.
 */
const agentChatUsageBreakdownSchema = z.strictObject({
    label: z.string().min(1).max(80),
    tokens: z.number().int().nonnegative(),
});

/**
 * How much of the context window the conversation uses, as of the latest model response.
 */
export const agentChatUsageSchema = z.strictObject({
    totalTokens: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative().optional(),
    /**
     * The window the provider compacts against, when it is smaller than the model's own window (Claude Code's
     * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, or its 200K boundary on a 1M model). Pressure is measured against it.
     */
    compactWindow: z.number().int().positive().optional(),
    /**
     * Total past which the provider compacts on its own (Claude Code's `autoCompactThreshold`, below the window by a
     * reserve), when it reports one and auto-compact is on. Pressure is measured against it, the figure the Context tab
     * names, so the composer meter and the tab show one percentage.
     */
    autoCompactThreshold: z.number().int().positive().optional(),
    /**
     * What fills the window, as the provider reports it. Absent when it reports none, and dropped when a newer response
     * changes the total, so it never describes an older context.
     */
    breakdown: z
        .array(agentChatUsageBreakdownSchema)
        .max(MAX_AGENT_CHAT_USAGE_BREAKDOWN)
        .optional(),
    /**
     * How long the provider keeps the prompt cache after a request, in minutes.
     */
    cacheTtlMinutes: z.number().int().positive().optional(),
    /**
     * When the latest model response arrived, in epoch milliseconds: the prompt cache's lifetime counts from here.
     */
    lastResponseAt: z.number().int().nonnegative().optional(),
    /**
     * Estimated standard API price, in US dollars, of writing the whole context back into the cache once it expires.
     * Absent when the model is not in the price list.
     */
    cacheRewriteUsd: z.number().nonnegative().optional(),
});

export type AgentChatUsage = z.infer<typeof agentChatUsageSchema>;

/**
 * What one turn has spent so far, summed over every model response it made. Claude subagents' responses are included; a
 * Codex subagent runs in its own thread and is not counted. Server Core adds each response as it arrives, so a running
 * turn's figures grow live; they start over when the next turn begins. `requests` counts model responses, the steps of
 * the Agent loop. `totalTokens` uses the Usage page's definition (`input + output + cacheRead + cacheWrite`). `costUsd`
 * is the standard API price estimated from the bundled price list, absent while no response came from a priced model;
 * subscription plans spend allowance rather than billing it.
 */
export const agentChatTurnUsageSchema = z.strictObject({
    turnId: z.string().min(1).max(200),
    requests: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
});

export type AgentChatTurnUsage = z.infer<typeof agentChatTurnUsageSchema>;

/**
 * What a finished turn produced and cost, recorded on the turn once when it ends so its fold row can show them.
 */
export const agentChatTurnMetricsSchema = z.strictObject({
    /**
     * Output tokens over the time the model spent generating them, summed across the turn's responses (tool runs
     * excluded), from the provider's transcript; both absent when it records no timing.
     */
    outputTokens: z.number().int().nonnegative().optional(),
    generationMs: z.number().nonnegative().optional(),
    /**
     * The speed tier most of the turn's measured responses ran at, so the fold row can say whether the rate came from
     * Fast mode; absent when the transcript recorded no tier for most of them.
     */
    speed: agentThroughputSpeedSchema.optional(),
    /**
     * Estimated list-price cost of every response in the turn; absent when a response's model has no price.
     */
    costUsd: z.number().nonnegative().optional(),
    /**
     * The turn's steps (model responses) and total tokens (`input + output + cacheRead + cacheWrite`), the running
     * {@link agentChatTurnUsageSchema} figures frozen when the turn ended, so its fold row can show them afterwards.
     */
    requests: z.number().int().positive().optional(),
    totalTokens: z.number().int().positive().optional(),
});

export type AgentChatTurnMetrics = z.infer<typeof agentChatTurnMetricsSchema>;

/**
 * What the goal has spent across every turn that worked on it while it was active, in the same figures as
 * {@link agentChatTurnUsageSchema}, so a goal the provider pursues over many turns shows one running total instead of
 * figures that start over with each turn. `objective` names the goal it belongs to: a Client shows it only beside that
 * goal, Server Core starts over when another goal is set, and the reducer drops it with a cleared goal. It lives only
 * in the Chat's snapshot, so it covers the responses since that Chat last started with the goal active.
 */
export const agentChatGoalUsageSchema = agentChatTurnUsageSchema.omit({ turnId: true }).extend({
    objective: z.string().max(MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH),
});

export type AgentChatGoalUsage = z.infer<typeof agentChatGoalUsageSchema>;

/**
 * The smallest context idle compaction acts on. Compaction trades detail for a cheaper re-read: while the cache holds
 * it reads the context at the cache-read rate and writes a summary of a few thousand output tokens, and the next
 * message writes the compacted context (about 35k with the system prompt and tools) into the cache. An expired cache
 * instead rewrites the whole context at the one-hour cache-write rate (twice the input price). On Claude's prices that
 * breaks even near 50k tokens; the floor adds headroom for a Chat the user never returns to.
 *
 * Claude Code's own default (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, 200k) is not used: on a 200K window Claude Code
 * compacts on its own near 167k, so such a Chat never reached it.
 *
 * @see https://github.com/tjx666/caxri/issues/2691
 */
const AGENT_CHAT_IDLE_COMPACTION_MIN_TOKENS = 80_000;

/**
 * The shortest prompt cache lifetime idle compaction acts on. A five-minute cache would compact a Chat whose user is
 * still reading its reply; Claude Code likewise compacts only before the one-hour cache expires.
 */
const IDLE_COMPACTION_MIN_TTL_MINUTES = 60;

/**
 * The share of the cache lifetime a Chat waits before it is compacted: 54 minutes of a one-hour cache, as Claude Code
 * does. The rest leaves time for the compaction request to reach the provider while the cache still holds.
 */
const IDLE_COMPACTION_FIRE_FRACTION = 0.9;

/**
 * How long after a plan limit's reset a held idle compaction runs: a provider's reset time is rounded, and a request at
 * the exact second may still be refused.
 */
const IDLE_COMPACTION_RESET_MARGIN_MS = 30_000;

/**
 * The providers whose Chats are compacted while idle. Codex is left out: a ChatGPT sign-in keeps its cache with no
 * expiry, so there is nothing to save (see `codexCacheTtlMinutes` in Server Core).
 */
const IDLE_COMPACTION_PROVIDERS: ReadonlySet<AgentProvider> = new Set(['claude', 'grok']);

/**
 * When an idle Chat becomes due for idle compaction, in epoch milliseconds, or `undefined` when it never will on this
 * usage: the provider is not covered, the cache lifetime is unknown or too short, the context is too small, or no
 * response started the cache. It is due from that moment until the cache expires (`lastResponseAt + cacheTtlMinutes`);
 * a compaction resets `lastResponseAt`, so one response is compacted at most once.
 *
 * `hold` is the snapshot's `idleCompactionHold`: a used-up plan limit found when compaction came due. For the response
 * it names, compaction moves past the reset while the cache still holds then, and is dropped when the cache expires
 * first, so the user decides how to go on instead of a compaction failing into the limit.
 */
export function agentChatIdleCompactionAt(
    usage: Pick<AgentChatUsage, 'cacheTtlMinutes' | 'lastResponseAt' | 'totalTokens'> | undefined,
    provider: AgentProvider | undefined,
    hold?: AgentChatSnapshot['idleCompactionHold'],
): number | undefined {
    if (!usage || !provider || !IDLE_COMPACTION_PROVIDERS.has(provider)) return undefined;
    const { cacheTtlMinutes, lastResponseAt, totalTokens } = usage;
    if (
        lastResponseAt === undefined ||
        cacheTtlMinutes === undefined ||
        cacheTtlMinutes < IDLE_COMPACTION_MIN_TTL_MINUTES ||
        totalTokens < AGENT_CHAT_IDLE_COMPACTION_MIN_TOKENS
    )
        return undefined;
    const dueAt =
        lastResponseAt + Math.round(cacheTtlMinutes * 60_000 * IDLE_COMPACTION_FIRE_FRACTION);
    if (hold?.lastResponseAt !== lastResponseAt) return dueAt;
    const expiresAt = lastResponseAt + cacheTtlMinutes * 60_000;
    const afterReset = hold.resetsAt + IDLE_COMPACTION_RESET_MARGIN_MS;
    return afterReset < expiresAt ? Math.max(dueAt, afterReset) : undefined;
}

/**
 * The message Caxri sends a Session's primary Agent when its pull request merges (`projectStatus.notifyAgentOnMerge`).
 */
export function formatMergeNotice(url: string): string {
    return `Pull request ${url} has been merged.`;
}

/**
 * Whether idle compaction leaves this Chat alone because its delivery ended: the Session's pull request merged and
 * nothing but Caxri's own merge notice reached the Chat afterwards. Any other message after the merge (a follow-up
 * question, a new task) means the conversation goes on, so its cache is still worth a summary. A merge with no recorded
 * time counts as ended, since no message can be placed after it.
 */
export function isAgentChatEndedByMerge(
    items: readonly AgentChatItem[] | undefined,
    pullRequest: Pick<SessionPullRequest, 'mergedAt' | 'state' | 'url'> | undefined,
): boolean {
    if (pullRequest?.state !== 'merged') return false;
    const { mergedAt, url } = pullRequest;
    if (mergedAt === undefined) return true;
    const notice = formatMergeNotice(url);
    return !items?.some(
        (item) =>
            item.type === 'userMessage' &&
            item.createdAt !== undefined &&
            item.createdAt > mergedAt &&
            item.text !== notice,
    );
}

/**
 * Share of the compaction window past which the context counts as high: the composer suggests compacting. Set close to
 * where the provider compacts on its own, so the suggestion arrives while compacting by hand still saves a turn,
 * without reading as a false alarm for most of a long conversation.
 *
 * The meter turns `--warning` at the same share rather than earlier: below it the ring stays a quiet neutral glyph, so
 * a color change means "worth compacting" and not "past half full". A full context is advice to compact, not a failure,
 * so it never turns `--danger` beside the composer's `--warning` suggestion.
 */
export const AGENT_CHAT_HIGH_CONTEXT_SHARE = 0.85;

/**
 * How full the context window is, for the composer's meter on Desktop and the phone. Omitted until the provider reports
 * a window size.
 */
export interface AgentChatContextUsage {
    /**
     * Share of `limit` in use, from 0 to 1.
     */
    used: number;
    totalTokens: number;
    /**
     * The window the breakdown fills: the provider's compaction window when it is smaller than the model's.
     */
    window: number;
    /**
     * The denominator of `used` and of every percentage: `compactAt` when the provider reports one, otherwise `window`.
     */
    limit: number;
    /**
     * Where the provider compacts on its own, when it says so.
     */
    compactAt?: number;
    /**
     * The model's own window, when the compaction window is smaller than it.
     */
    modelWindow?: number;
    tone: 'normal' | 'warning';
    breakdown: NonNullable<AgentChatUsage['breakdown']>;
}

/**
 * The whole-number share of `window` that `tokens` fill, from 0 to 100. Every context percentage on every Client rounds
 * through here, so two surfaces never show the same context as `1%` and `1.3%`.
 */
export function agentChatContextPercent(tokens: number, window: number): number {
    return window > 0 ? Math.round(Math.min(tokens / window, 1) * 100) : 0;
}

/**
 * The denominator every context percentage uses: where the provider compacts on its own when it says so, otherwise the
 * window pressure is measured against, so one Chat never shows `85%` in one place and `71%` in another for the same
 * tokens.
 */
export function agentChatContextLimit(window: number, autoCompactAt: number | undefined): number {
    return autoCompactAt !== undefined && autoCompactAt > 0 ? autoCompactAt : window;
}

export function agentChatContextUsage(
    usage: AgentChatUsage | undefined,
): AgentChatContextUsage | undefined {
    const window = usage?.compactWindow ?? usage?.contextWindow;
    if (!usage || !window) return undefined;
    const limit = agentChatContextLimit(window, usage.autoCompactThreshold);
    const share = usage.totalTokens / limit;
    return {
        used: Math.min(share, 1),
        totalTokens: usage.totalTokens,
        window,
        limit,
        ...(usage.autoCompactThreshold && { compactAt: usage.autoCompactThreshold }),
        ...(usage.compactWindow &&
            usage.contextWindow &&
            usage.contextWindow > usage.compactWindow && { modelWindow: usage.contextWindow }),
        tone: share >= AGENT_CHAT_HIGH_CONTEXT_SHARE ? 'warning' : 'normal',
        breakdown: usage.breakdown ?? [],
    };
}

/**
 * The prompt cache's state right now, from when the latest response arrived and the lifetime it was written with.
 */
export function agentChatCacheClock(
    lastResponseAt: number | undefined,
    ttlMinutes: number,
    now: number,
): { state: 'warm' | 'expired'; remainingMs: number; idleMs: number } | undefined {
    if (lastResponseAt === undefined) return undefined;
    const idleMs = Math.max(0, now - lastResponseAt);
    const remainingMs = ttlMinutes * 60_000 - idleMs;
    return { state: remainingMs > 0 ? 'warm' : 'expired', remainingMs, idleMs };
}
