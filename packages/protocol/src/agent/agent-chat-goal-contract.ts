import { z } from 'zod';

/**
 * Codex's own limit for a thread goal's objective (`MAX_THREAD_GOAL_OBJECTIVE_CHARS`), which rejects a longer one.
 */
export const MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH = 4_000;

/**
 * The longest goal-ending reason a snapshot carries. Claude Code's evaluator writes a paragraph; this keeps a runaway
 * one from bloating every snapshot.
 */
export const MAX_AGENT_CHAT_GOAL_REASON_LENGTH = 4_000;

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
    /**
     * The provider judged the goal impossible and stopped pursuing it for good (Claude Code's "Goal could not be
     * achieved"). Unlike `blocked`, nothing resumes it; only a new goal does.
     */
    'failed',
]);

/**
 * The goal the provider keeps working toward across turns (Codex and Claude Code `/goal`). Times are the provider's:
 * `timeUsedSeconds` is what it had counted at `updatedAt`, so a Client adds the running turn's time on top while the
 * goal is active.
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
     * Why the provider ended the goal, from its last check: what made it `complete` or `failed`. Absent while the goal
     * runs and for a provider that gives no reason.
     */
    reason: z.string().max(MAX_AGENT_CHAT_GOAL_REASON_LENGTH).optional(),
    /**
     * When the provider last reported the goal, in epoch milliseconds.
     */
    updatedAt: z.number().int().nonnegative(),
    /**
     * `false` when the provider cannot pause the goal (Claude Code's `/goal` only sets and clears), so no Client offers
     * Pause; a pause sent there would become a new goal named "pause".
     */
    pausable: z.literal(false).optional(),
});

export type AgentChatGoal = z.infer<typeof agentChatGoalSchema>;
