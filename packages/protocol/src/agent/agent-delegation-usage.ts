import { z } from 'zod';

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Native provider counters for the exact main-thread task, without estimated pricing or child-agent billing.
 */
export const agentDelegationUsageSchema = z.strictObject({
    source: z.literal('provider'),
    scope: z.literal('main-thread'),
    inputTokens: tokens,
    outputTokens: tokens,
    cacheReadTokens: tokens.optional(),
    cacheWriteTokens: tokens.optional(),
    reasoningTokens: tokens.optional(),
    totalTokens: tokens.optional(),
});

export type AgentDelegationUsage = z.infer<typeof agentDelegationUsageSchema>;
