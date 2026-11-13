import { z } from 'zod';

import { identifierSchema } from '../identifiers.js';

/**
 * The most attention rows `session.workSummary` lists. The menu bar shows them as menu items, where a longer list stops
 * being scannable; the count still says how many there are.
 */
export const SESSION_WORK_SUMMARY_ATTENTION_MAX = 8;

const sessionWorkAttentionSchema = z.strictObject({
    sessionId: identifierSchema,
    title: z.string().max(200),
    projectTitle: z.string().max(200),
    /**
     * `waiting` blocks the Agent on the user's answer; `failed` ended the turn with an error; `result` has a finished
     * turn to read. Same tiers as the Activity view's Needs attention group.
     */
    kind: z.enum(['failed', 'result', 'waiting']),
});
export type SessionWorkAttention = z.infer<typeof sessionWorkAttentionSchema>;

/**
 * Whole-app work at a glance, without the Session list: what the menu bar shows while no window is open, and what
 * Server Core reads to decide whether the Mac must stay awake. See docs/unattended-mode.md.
 */
export const sessionWorkSummarySchema = z.strictObject({
    /**
     * Sessions whose Primary Agent is running a turn or compacting, the Activity view's Working group.
     */
    working: z.number().int().nonnegative(),
    /**
     * Chats waiting for a plan limit to reset. They continue on their own, so they still need the Mac awake, but they
     * ask nothing of the user.
     */
    usageWaiting: z.number().int().nonnegative(),
    /**
     * How many Sessions the Activity view lists under Needs attention.
     */
    attentionCount: z.number().int().nonnegative(),
    /**
     * The first {@link SESSION_WORK_SUMMARY_ATTENTION_MAX} of them in the Activity view's order: blocked Agents first,
     * then the newest arrival.
     */
    attention: z.array(sessionWorkAttentionSchema).max(SESSION_WORK_SUMMARY_ATTENTION_MAX),
});
export type SessionWorkSummary = z.infer<typeof sessionWorkSummarySchema>;
