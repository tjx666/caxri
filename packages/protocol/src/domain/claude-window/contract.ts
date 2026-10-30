import { z } from 'zod';

import { commandPolicy } from '../../transport/method-spec.js';

/**
 * Length of a Claude subscription's rolling usage window.
 */
export const CLAUDE_WINDOW_MINUTES = 300;

/**
 * Default `First workday reset at`: 10:00 local time, which puts the morning anchor at 05:00.
 */
export const DEFAULT_FIRST_WORKDAY_RESET_MINUTES = 600;

const minuteOfDay = z.number().int().min(0).max(1_439);
const epochMs = z.number().int().nonnegative();
const wakeTimeSchema = z.object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
});

/**
 * What the Claude 5-hour window keeper is doing for the signed-in account. `windowActive` means an active window that
 * Caxri renews when it resets; `waitingForNaturalReset` means an active window whose renewal would cover the next
 * morning anchor, so Caxri lets it run out and stays idle until the anchor. `confirmed` is an active window Caxri's own
 * request started.
 */
const claudeWindowStatusIds = [
    'off',
    'waitingForAnchor',
    'windowActive',
    'waitingForNaturalReset',
    'triggering',
    'confirmed',
    'unavailable',
] as const;
export type ClaudeWindowStatus = (typeof claudeWindowStatusIds)[number];

/**
 * Why the keeper is paused and sends nothing. Every reason fails closed:
 *
 * - `notSignedIn`: Claude Code reports no claude.ai account identity.
 * - `authUnsupported`: the billing path is not a first-party claude.ai subscription (an API key, a third-party provider,
 *   a gateway, or credentials in the environment), so a request could bill API credits.
 * - `planUnsupported`: the account has no Pro or Max subscription.
 * - `usageUnavailable`: Claude Code returned no fresh 5-hour window reading.
 * - `weeklyLimit`: the weekly limit is used up.
 * - `claudeNotFound`: the Claude CLI could not be found or started.
 * - `probeFailed`: Claude Code did not answer in time or answered something Caxri does not understand.
 */
const claudeWindowUnavailableReasons = [
    'notSignedIn',
    'authUnsupported',
    'planUnsupported',
    'usageUnavailable',
    'weeklyLimit',
    'claudeNotFound',
    'probeFailed',
] as const;
export type ClaudeWindowUnavailableReason = (typeof claudeWindowUnavailableReasons)[number];

/**
 * The closed result of one keeper decision that did something, recorded per account and in the structured log.
 * `renewal_skipped` is a night renewal that would have covered the next morning anchor.
 */
export const claudeWindowOutcomes = [
    'natural_window_started',
    'trigger_confirmed',
    'trigger_unverified',
    'trigger_failed',
    'renewal_skipped',
    'weekly_limit',
    'auth_unsupported',
    'missed_while_asleep',
] as const;
export type ClaudeWindowOutcome = (typeof claudeWindowOutcomes)[number];

/**
 * Whether Desktop registered the background job that wakes the keeper while Caxri is closed. `unpackaged` covers a
 * development build, which never registers one; the in-process timer still runs while Server Core is up.
 * `notRegistered` means the keeper is off, so Desktop removed the job.
 */
const claudeWindowBackgroundStates = [
    'registered',
    'notRegistered',
    'unpackaged',
    'unsupportedPlatform',
    'registerFailed',
    'unknown',
] as const;
export type ClaudeWindowBackgroundState = (typeof claudeWindowBackgroundStates)[number];

const claudeWindowAccountSchema = z.object({
    /**
     * Anonymous account key (a prefix of the account identity hash), never the email or organization.
     */
    key: z.string().min(1).max(64),
    /**
     * Claude Code's plan name, such as `pro` or `max`.
     */
    planType: z.string().max(64).optional(),
    keepRolling: z.boolean(),
    /**
     * True while the switch follows the plan's default (on for Pro) because the user never chose.
     */
    keepRollingIsDefault: z.boolean(),
    firstWorkdayResetMinutes: minuteOfDay,
});

const claudeWindowStateSchema = z.object({
    /**
     * Absent until Claude Code identified a claude.ai account.
     */
    account: claudeWindowAccountSchema.optional(),
    status: z.enum(claudeWindowStatusIds),
    reason: z.enum(claudeWindowUnavailableReasons).optional(),
    /**
     * When the current 5-hour window resets, as Claude Code reported it.
     */
    windowResetsAt: epochMs.optional(),
    /**
     * The next morning anchor, `First workday reset at` minus five hours in the local time zone.
     */
    nextAnchorAt: epochMs.optional(),
    /**
     * The first workday reset the next anchor's window produces.
     */
    nextWorkdayResetAt: epochMs.optional(),
    lastOutcome: z
        .object({
            outcome: z.enum(claudeWindowOutcomes),
            at: epochMs,
            /**
             * The planned anchor or renewal this outcome served when the Mac was asleep or Caxri was closed at that
             * time, so the one catch-up check after waking is visible as such.
             */
            missedPlannedAt: epochMs.optional(),
        })
        .optional(),
    background: z.enum(claudeWindowBackgroundStates),
    checkedAt: epochMs.optional(),
    /**
     * Local `HH:MM` times the background job should wake the keeper each day: the anchor and the renewals the anchored
     * chain reaches before the next anchor. Empty when the keeper is off.
     */
    wakeTimes: z.array(wakeTimeSchema).max(8),
});
export type ClaudeWindowState = z.infer<typeof claudeWindowStateSchema>;

export const claudeWindowMethods = {
    /**
     * The keeper's state for the signed-in Claude account. Reads Claude Code again when the last reading is older than
     * a minute, which starts a short-lived Claude process but never sends a model request.
     */
    'claudeWindow.status': {
        ...commandPolicy('server', 'read', ['settings.read']),
        params: z.object({ refresh: z.boolean().default(false) }).default({ refresh: false }),
        result: claudeWindowStateSchema,
    },
    /**
     * Saves the signed-in account's own choice. An explicit `keepRolling` survives later plan re-detection.
     */
    'claudeWindow.update': {
        ...commandPolicy('server', 'write', ['settings.write']),
        params: z.strictObject({
            accountKey: z.string().min(1).max(64),
            keepRolling: z.boolean().optional(),
            firstWorkdayResetMinutes: minuteOfDay.optional(),
        }),
        result: claudeWindowStateSchema,
    },
    /**
     * Runs one due check now: the background job calls it through the CLI when launchd wakes it. Idempotent per window,
     * so a repeated or late call never sends a second request for the same window.
     */
    'claudeWindow.tick': {
        ...commandPolicy('server', 'control', ['settings.write']),
        params: z.object({}).default({}),
        result: claudeWindowStateSchema,
    },
    /**
     * Desktop reports whether it registered the background job; held in memory for the Server Core lifetime.
     */
    'claudeWindow.reportBackground': {
        ...commandPolicy('server', 'write'),
        params: z.strictObject({ state: z.enum(claudeWindowBackgroundStates) }),
        result: z.object({ accepted: z.boolean() }),
    },
} as const;
