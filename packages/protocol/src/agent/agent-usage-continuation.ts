import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { UsageLimit } from '../domain/usage-contract.js';
import { agentProviderSchema } from './agents.js';

/**
 * Raw weekly usage, in percent, at which Server Core stops ordinary model requests for the provider's account and keeps
 * the rest for one hand-off (issue #2580). Compared against the provider's own figure, never a rounded display value.
 */
export const AGENT_USAGE_GUARD_PERCENT = 99;

/**
 * Which plan window a provider reported as used up: `session` is the 5-hour window, `weekly` the account's general
 * weekly window, and `unknown` a limit the provider did not attribute to either.
 */
export const agentUsageLimitWindowSchema = z.enum(['session', 'weekly', 'unknown']);
export type AgentUsageLimitWindow = z.infer<typeof agentUsageLimitWindowSchema>;

/**
 * The Session another Agent continued this work in, so the source links to its continuation.
 */
export const agentChatContinuationSchema = z.strictObject({
    sessionId: identifierSchema,
    provider: agentProviderSchema,
});
export type AgentChatContinuation = z.infer<typeof agentChatContinuationSchema>;

/**
 * Set on a turn's `error` notice when the provider failed it because the plan's usage limit is used up, so a Client can
 * offer to continue in another Agent instead of matching provider text. Ordinary rate limits, overload, network, and
 * authentication failures never carry it.
 */
export const agentChatUsageLimitSchema = z.strictObject({
    window: agentUsageLimitWindowSchema,
    /**
     * When the provider says the window resets, in epoch milliseconds.
     */
    resetsAt: z.number().int().positive().optional(),
    /**
     * Where another Agent continued from this failure. Server Core stamps it from the continuation's own delegation
     * record, so it survives a history replay.
     */
    continuedIn: agentChatContinuationSchema.optional(),
});
export type AgentChatUsageLimit = z.infer<typeof agentChatUsageLimitSchema>;

/**
 * State of the account-wide hand-off budget kept back by the usage guard: `available` until one Chat generates a
 * hand-off, `generating` while it does, `used` once it ran (whatever the outcome), so the last percent is spent at most
 * once per account and weekly window.
 */
export const agentUsageHandoffLeaseSchema = z.enum(['available', 'generating', 'used']);
export type AgentUsageHandoffLease = z.infer<typeof agentUsageHandoffLeaseSchema>;

/**
 * A provider account at or above {@link AGENT_USAGE_GUARD_PERCENT} of its weekly window: every ordinary model request is
 * refused until `resetsAt`.
 */
export const agentUsageGuardSchema = z.strictObject({
    provider: agentProviderSchema,
    usedPercent: z.number().min(0).max(100),
    resetsAt: z.number().int().positive(),
    handoff: agentUsageHandoffLeaseSchema,
});
export type AgentUsageGuard = z.infer<typeof agentUsageGuardSchema>;

/**
 * A hand-off document the source model wrote on the guard's reserved budget. `failed` keeps no text; the deterministic
 * path still works. Private user content: never logged.
 */
export const agentChatHandoffSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('generating'), startedAt: z.number().int().positive() }),
    z.strictObject({
        status: z.literal('generated'),
        text: z.string().min(1).max(16_000),
        createdAt: z.number().int().positive(),
    }),
    z.strictObject({
        status: z.literal('failed'),
        reason: z.enum(['rejected', 'timeout', 'unavailable', 'empty']),
        createdAt: z.number().int().positive(),
    }),
]);
export type AgentChatHandoff = z.infer<typeof agentChatHandoffSchema>;

/**
 * The usage guard as one Chat sees it: its account's guard, plus this Chat's hand-off document and the Session its work
 * continued in, both only for the guard's window.
 */
export const agentChatUsageGuardSchema = agentUsageGuardSchema.extend({
    document: agentChatHandoffSchema.optional(),
    continuedIn: agentChatContinuationSchema.optional(),
});
export type AgentChatUsageGuard = z.infer<typeof agentChatUsageGuardSchema>;

/**
 * Why a provider cannot take over the work. `current` is the Chat's own provider; `unsupported` has no Agent Chat.
 */
export const agentChatContinuationTargetUnavailableSchema = z.enum([
    'current',
    'notInstalled',
    'unsupported',
    'usageLimited',
]);

export const agentChatContinuationTargetSchema = z.strictObject({
    provider: agentProviderSchema,
    unavailable: agentChatContinuationTargetUnavailableSchema.optional(),
    /**
     * For `usageLimited`: when that provider's weekly window resets.
     */
    resetsAt: z.number().int().positive().optional(),
});
export type AgentChatContinuationTarget = z.infer<typeof agentChatContinuationTargetSchema>;

/**
 * The provider's general weekly window when its raw usage is at or past {@link AGENT_USAGE_GUARD_PERCENT} and it has not
 * reset by `now`. A window without a known reset cannot be held to an end, so it never arms the guard; nor does a
 * model-specific window, which the parsers leave unscoped.
 */
export function weeklyUsageGuardWindow(
    limit: Pick<UsageLimit, 'windows'> | undefined,
    now: number,
): { usedPercent: number; resetsAt: number } | undefined {
    const window = limit?.windows.find((candidate) => candidate.scope === 'weekly');
    if (!window?.resetsAt || window.resetsAt <= now) return undefined;
    if (window.usedPercent < AGENT_USAGE_GUARD_PERCENT) return undefined;
    return { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
}
