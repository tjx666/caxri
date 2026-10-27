import { z } from 'zod';

import { MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH } from './agent-chat-goal-contract.js';
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
export const AGENT_CHAT_IDLE_COMPACTION_MIN_TOKENS = 80_000;

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
 * The providers whose Chats are compacted while idle. Codex is left out: a ChatGPT sign-in keeps its cache with no
 * expiry, so there is nothing to save (see `codexCacheTtlMinutes` in Server Core).
 */
const IDLE_COMPACTION_PROVIDERS: ReadonlySet<AgentProvider> = new Set(['claude', 'grok']);

/**
 * When an idle Chat becomes due for idle compaction, in epoch milliseconds, or `undefined` when it never will on this
 * usage: the provider is not covered, the cache lifetime is unknown or too short, the context is too small, or no
 * response started the cache. It is due from that moment until the cache expires (`lastResponseAt + cacheTtlMinutes`);
 * a compaction resets `lastResponseAt`, so one response is compacted at most once.
 */
export function agentChatIdleCompactionAt(
    usage: Pick<AgentChatUsage, 'cacheTtlMinutes' | 'lastResponseAt' | 'totalTokens'> | undefined,
    provider: AgentProvider | undefined,
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
    return lastResponseAt + Math.round(cacheTtlMinutes * 60_000 * IDLE_COMPACTION_FIRE_FRACTION);
}
