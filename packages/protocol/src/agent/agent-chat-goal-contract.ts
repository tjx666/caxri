import { z } from 'zod';

/**
 * Codex's own limit for a thread goal's objective (`MAX_THREAD_GOAL_OBJECTIVE_CHARS`), which rejects a longer one.
 */
export const MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH = 4_000;

/**
 * Where a provider's long-running goal stands: Codex's thread goal statuses, which keep the Agent starting turns on its
 * own while `active`.
 */
export const agentChatGoalStatusSchema = z.enum([
    'active',
    'paused',
    /**
     * The provider stopped pursuing it on its own, such as after several turns that made no progress.
     */
    'blocked',
    'usageLimited',
    'budgetLimited',
    'complete',
]);

/**
 * The goal the provider keeps working toward across turns (Codex `/goal`). Times are the provider's: `timeUsedSeconds`
 * is what it had counted at `updatedAt`, so a Client adds the running turn's time on top while the goal is active.
 */
export const agentChatGoalSchema = z.strictObject({
    objective: z.string().max(MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH),
    status: agentChatGoalStatusSchema,
    tokensUsed: z.number().int().nonnegative(),
    /**
     * The token budget that ends the goal as `budgetLimited`; absent when it has none.
     */
    tokenBudget: z.number().int().positive().optional(),
    timeUsedSeconds: z.number().nonnegative(),
    /**
     * When the provider last reported the goal, in epoch milliseconds.
     */
    updatedAt: z.number().int().nonnegative(),
});

export type AgentChatGoal = z.infer<typeof agentChatGoalSchema>;
export type AgentChatGoalStatus = z.infer<typeof agentChatGoalStatusSchema>;
