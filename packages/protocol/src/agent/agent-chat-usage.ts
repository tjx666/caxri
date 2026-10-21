import { z } from 'zod';

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
