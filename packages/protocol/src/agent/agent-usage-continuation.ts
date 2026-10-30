import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { UsageCredits, UsageLimit } from '../domain/usage-contract.js';
import { hasUsableCredits } from '../domain/usage-contract.js';
import { agentProviderSchema } from './agents.js';

/**
 * Raw weekly usage, in percent, at which Server Core stops ordinary model requests for the provider's account and keeps
 * the rest for one hand-off (issue #2580). Compared against the provider's own figure, never a rounded display value.
 */
const AGENT_USAGE_GUARD_PERCENT = 99;

/**
 * Which plan window a provider reported as used up: `session` is the 5-hour window, `weekly` the account's general
 * weekly window, and `unknown` a limit the provider did not attribute to either.
 */
export const agentUsageLimitWindowSchema = z.enum(['session', 'weekly', 'unknown']);
export type AgentUsageLimitWindow = z.infer<typeof agentUsageLimitWindowSchema>;

/**
 * The Session another Agent continued this work in, so the source links to its continuation.
 */
const agentChatContinuationSchema = z.strictObject({
    sessionId: identifierSchema,
    provider: agentProviderSchema,
});
export type AgentChatContinuation = z.infer<typeof agentChatContinuationSchema>;

/**
 * At most this far ahead may a reset be for the Chat to wait for it on its own: a 5-hour window always fits, a weekly
 * window days away does not (issue #2220). Claude Code's own `autoContinueAtUsageLimit` uses the same horizon.
 */
export const AGENT_CHAT_AUTO_CONTINUE_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Automatic continuations a Chat makes in a row without the user's input. The first wait plus two more covers a reset
 * that a provider reports a little early, as Claude Code's own wait does; a limit that keeps failing the continuation
 * is left to the user.
 */
export const AGENT_CHAT_AUTO_CONTINUE_MAX_ATTEMPTS = 3;

/**
 * Why a Chat does not continue on its own once this limit resets: the provider named no reset time, the reset is beyond
 * {@link AGENT_CHAT_AUTO_CONTINUE_HORIZON_MS}, the Chat already continued {@link AGENT_CHAT_AUTO_CONTINUE_MAX_ATTEMPTS}
 * times in a row into the limit, or the account's weekly usage guard holds new requests back.
 */
const agentChatAutoContinueSkipReasonSchema = z.enum([
    'resetUnknown',
    'resetTooFar',
    'attemptsUsed',
    'usageGuard',
]);
export type AgentChatAutoContinueSkipReason = z.infer<typeof agentChatAutoContinueSkipReasonSchema>;

/**
 * The Chat continuing on its own after the limit resets (issue #2220), as Server Core schedules it: `waiting` until
 * `at` (the reset plus a short stagger), `continued` once a new turn started at `at`, `missed` when the Chat could not
 * continue near the reset (the Mac slept through it, or Server Core was not running), so the user decides instead, and
 * `skipped` with why it never waited. A cancelled wait drops the field. Server Core persists the latest wait per
 * Terminal, so a restart keeps a `waiting` Chat waiting, and a history replay that lost the failed turn's notice
 * (Claude Code's transcript keeps none) gets it back while the wait is `waiting` or `missed`.
 */
export const agentChatAutoContinueSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('waiting'), at: z.number().int().positive() }),
    z.strictObject({ status: z.literal('continued'), at: z.number().int().positive() }),
    z.strictObject({ status: z.literal('missed') }),
    z.strictObject({ status: z.literal('skipped'), reason: agentChatAutoContinueSkipReasonSchema }),
]);
export type AgentChatAutoContinue = z.infer<typeof agentChatAutoContinueSchema>;

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
    /**
     * Whether the Chat continues on its own once the limit resets; absent while that is off or was cancelled.
     */
    autoContinue: agentChatAutoContinueSchema.optional(),
    /**
     * Set when Caxri's own weekly usage guard stopped the turn, not the provider's failure (issue #2733): the notice is
     * the wait's anchor after the guard lifts, and a Client words its headline for the guard instead of a failed turn.
     */
    trigger: z.literal('usageGuard').optional(),
});
export type AgentChatUsageLimit = z.infer<typeof agentChatUsageLimitSchema>;

/**
 * State of the account-wide hand-off budget kept back by the usage guard: `available` until one Chat generates a
 * hand-off, `generating` while it does, `used` once it ran (whatever the outcome), so the last percent is spent at most
 * once per account and weekly window.
 */
const agentUsageHandoffLeaseSchema = z.enum(['available', 'generating', 'used']);

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
 * continued in, both only for the guard's window, and whether the turn the guard stopped continues on its own once the
 * window resets (issue #2733; `autoContinueTurnId` names that turn for Cancel).
 */
export const agentChatUsageGuardSchema = agentUsageGuardSchema.extend({
    document: agentChatHandoffSchema.optional(),
    continuedIn: agentChatContinuationSchema.optional(),
    autoContinue: agentChatAutoContinueSchema.optional(),
    autoContinueTurnId: z.string().min(1).max(200).optional(),
});
export type AgentChatUsageGuard = z.infer<typeof agentChatUsageGuardSchema>;

/**
 * Why a provider cannot take over the work. `current` is the Chat's own provider; `unsupported` has no Agent Chat.
 */
const agentChatContinuationTargetUnavailableSchema = z.enum([
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
 * How long dismissing the credits notice hides it, from any Client.
 */
export const CREDITS_NOTICE_DISMISS_MS = 24 * 60 * 60_000;

/**
 * The provider's general weekly window when its raw usage is at or past {@link AGENT_USAGE_GUARD_PERCENT} and it has not
 * reset by `now`. A window without a known reset cannot be held to an end, so it never qualifies; nor does a
 * model-specific window, which the parsers leave unscoped.
 */
function weeklyWindowAtGuard(
    limit: Pick<UsageLimit, 'windows'> | null | undefined,
    now: number,
): { usedPercent: number; resetsAt: number } | undefined {
    const window = limit?.windows.find((candidate) => candidate.scope === 'weekly');
    if (!window?.resetsAt || window.resetsAt <= now) return undefined;
    if (window.usedPercent < AGENT_USAGE_GUARD_PERCENT) return undefined;
    return { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
}

/**
 * The weekly window that arms the usage guard ({@link weeklyWindowAtGuard}). An account with usable credits keeps
 * working past its weekly window by spending them, so there is no last percent to protect; it gets the credits notice
 * instead ({@link weeklyCreditsNotice}).
 */
export function weeklyUsageGuardWindow(
    limit: Pick<UsageLimit, 'windows' | 'credits'> | undefined,
    now: number,
): { usedPercent: number; resetsAt: number } | undefined {
    if (hasUsableCredits(limit?.credits)) return undefined;
    return weeklyWindowAtGuard(limit, now);
}

/**
 * The weekly window at the guard of an account that still has usable credits: requests go on, now spending credits,
 * until the window resets. The pace reminder gives way to the credits notice while this holds.
 */
export function weeklyCreditsWindow(
    limit: Pick<UsageLimit, 'windows' | 'credits'> | null | undefined,
    now: number,
): { usedPercent: number; resetsAt: number; credits: UsageCredits } | undefined {
    const credits = limit?.credits;
    if (!credits || !hasUsableCredits(credits)) return undefined;
    const window = weeklyWindowAtGuard(limit, now);
    return window && { ...window, credits };
}

/**
 * What the composer's credits notice shows: the {@link weeklyCreditsWindow}, except for {@link CREDITS_NOTICE_DISMISS_MS}
 * after the user dismissed it on any Client. Without usable credits the guard itself shows instead.
 */
export function weeklyCreditsNotice(
    limit: Pick<UsageLimit, 'windows' | 'credits' | 'creditsNoticeDismissedAt'> | null | undefined,
    now: number,
): { usedPercent: number; resetsAt: number; credits: UsageCredits } | undefined {
    const dismissedAt = limit?.creditsNoticeDismissedAt;
    if (dismissedAt !== undefined && now - dismissedAt < CREDITS_NOTICE_DISMISS_MS)
        return undefined;
    return weeklyCreditsWindow(limit, now);
}
