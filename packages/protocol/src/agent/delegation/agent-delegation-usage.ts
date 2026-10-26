import { z } from 'zod';

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Native provider counters for the exact task. Scope distinguishes main-thread counters from provider totals that
 * include native subagents; neither scope contains estimated pricing.
 */
export const agentDelegationUsageSchema = z.strictObject({
    source: z.literal('provider'),
    scope: z.enum(['main-thread', 'provider-task']),
    inputTokens: tokens,
    outputTokens: tokens,
    cacheReadTokens: tokens.optional(),
    cacheWriteTokens: tokens.optional(),
    reasoningTokens: tokens.optional(),
    totalTokens: tokens.optional(),
});

export type AgentDelegationUsage = z.infer<typeof agentDelegationUsageSchema>;
