import { z } from 'zod';

import { sessionRelationSchema } from '../../domain/domain.js';
import { identifierSchema } from '../../domain/identifiers.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { ownerOnlyCommandPolicy } from '../../transport/method-spec.js';
import { agentProviderIds } from '../agents.js';
import { delegationApprovalSummarySchema } from './agent-delegation-approval.js';
import { agentDelegationApprovalMethods } from './agent-delegation-approval-contract.js';
import {
    agentDelegationFailureSchema,
    agentDelegationStatusSchema,
    delegationRetryScheduleOutcomeSchema,
} from './agent-delegation-contract.js';
import {
    delegationQuestionSummarySchema,
    delegationWaitingOnSchema,
} from './agent-delegation-question.js';
import {
    agentDelegationQuestionMethods,
    agentDelegationQuestionOwnerMethods,
} from './agent-delegation-question-contract.js';
import {
    delegationProviderSchema,
    delegationSelectionSchema,
} from './agent-delegation-settings.js';

/**
 * Most creating Sessions one `agent.delegation.sessions` read names; the sidebar asks for the Sessions it lists.
 */
export const MAX_DELEGATION_CREATORS = 64;

/**
 * Most Sessions one `agent.delegation.sessions` read returns, newest first. A creating Session with more has older
 * Sessions the read leaves out.
 */
export const MAX_DELEGATION_SESSIONS = 1000;

/**
 * Longest `step` of a Delegated Session, in characters. A step is one short line, never a transcript excerpt.
 */
export const MAX_DELEGATION_STEP_LENGTH = 120;

/**
 * Longest stored result summary, in characters (Unicode code points).
 */
export const MAX_DELEGATION_RESULT_SUMMARY_LENGTH = 280;

/**
 * Where a result summary came from: `authored` is the closing `Summary:` line the delegated Agent was told to write,
 * `excerpt` is the first paragraph of its answer, used when it wrote no such line.
 */
export const delegationResultSourceSchema = z.enum(['authored', 'excerpt']);
export type DelegationResultSource = z.infer<typeof delegationResultSourceSchema>;

/**
 * A step is clipped by characters, so a text of astral characters is up to twice as many UTF-16 units; the schema bound
 * is in units, which is what `z.string().max` counts.
 */
const stepSchema = z.string().max(MAX_DELEGATION_STEP_LENGTH * 2);

const agentDelegationResultSummarySchema = z.strictObject({
    summary: z.string().max(MAX_DELEGATION_RESULT_SUMMARY_LENGTH * 2),
    source: delegationResultSourceSchema,
    /**
     * The task that produced the summary. A Client compares it with the Session's `delegationId` (the newest task) to
     * tell whether the result belongs to that task or to an earlier completed one.
     */
    delegationId: identifierSchema,
    /**
     * When that task completed, in epoch milliseconds.
     */
    completedAt: z.number().int().positive(),
});

/**
 * One Session another Session created (see `sessionRelationSchema`) with what the delegation that runs in it shows.
 * Every field after `relation` is optional because a Session can exist with no delegation (a hand-off Session whose
 * task was pruned, or one an older build created).
 */
const agentDelegationSessionSchema = z.strictObject({
    sessionId: identifierSchema,
    createdBySessionId: identifierSchema,
    relation: sessionRelationSchema,
    delegationId: identifierSchema.optional(),
    provider: delegationProviderSchema.optional(),
    /**
     * The provider, model, effort and preset the task was admitted with, frozen at admission. It stays the label of a
     * preset removed from Settings since, and it is absent for a task started without a preset.
     */
    selection: delegationSelectionSchema.optional(),
    status: agentDelegationStatusSchema.optional(),
    failure: agentDelegationFailureSchema.optional(),
    failureResetsAt: z.number().int().positive().optional(),
    /**
     * The failed task this one retries, and the task a retry of this failed one runs as; see
     * `agentDelegationReceiptSchema`. Either may name a task pruned since.
     */
    retryOf: identifierSchema.optional(),
    retriedAs: identifierSchema.optional(),
    /**
     * Present while a scheduled retry of this failed task is pending; `retriedAs` is then the reserved successor, not a
     * started task. See `agentDelegationReceiptSchema`.
     */
    retryScheduledFor: z.number().int().positive().optional(),
    retryScheduleOutcome: delegationRetryScheduleOutcomeSchema.optional(),
    createdAt: z.number().int().positive().optional(),
    settledAt: z.number().int().positive().optional(),
    /**
     * When the user first acted in this Session (sent input, Stop, or Rewind), taking it over from the Session that
     * created it; from then on its replies no longer go back. Set once, and it survives a completed task. Absent until
     * a takeover.
     */
    takenOverAt: z.number().int().positive().optional(),
    /**
     * What an active Agent Chat Session is doing now, as one short label. Absent for a Terminal Session, a settled
     * task, and a Chat that is between steps.
     */
    step: stepSchema.optional(),
    /**
     * The newest completed task's result, which outlives the 1024-record pruning of delegations and the Session's
     * archival. It names its own task (`result.delegationId`), which differs from `delegationId` while a later task
     * runs or after one failed. Absent when the newest completed task yielded no summary.
     */
    result: agentDelegationResultSummarySchema.optional(),
    /**
     * The open question this Session's Agent asked the Agent that delegated it, without its text. See
     * `agent-delegation-question.ts`.
     */
    question: delegationQuestionSummarySchema.optional(),
    /**
     * Who the open `question` waits on. Derived from the question, never stored: `parent` until it escalates, then
     * `user`. Absent without an open question.
     */
    waitingOn: delegationWaitingOnSchema.optional(),
    /**
     * The pending permission request of this Session's Chat, without its content. Chat Sessions only; `waitingOn` is
     * derived from the questions and the approvals together. See `agent-delegation-approval.ts`.
     */
    approval: delegationApprovalSummarySchema.optional(),
});

export type AgentDelegationSession = z.infer<typeof agentDelegationSessionSchema>;

/**
 * Payload of the transient `agent.delegation.progress` event: the step an active Chat Session is on, or none once it is
 * between steps. It carries no task text, only the short label; it is never logged.
 */
export const agentDelegationProgressSchema = z.strictObject({
    sessionId: identifierSchema,
    delegationId: identifierSchema,
    step: stepSchema.optional(),
});

export type AgentDelegationProgress = z.infer<typeof agentDelegationProgressSchema>;

/**
 * Most task IDs one `agent.delegation.statuses` read names.
 */
export const MAX_DELEGATION_STATUS_IDS = 64;

/**
 * One named task's state, with no answer text and no summary. `failureResetsAt` and `provider` let a Client word a
 * limit failure; both are absent when unknown.
 */
const agentDelegationStatusEntrySchema = z.strictObject({
    delegationId: identifierSchema,
    sessionId: identifierSchema,
    provider: delegationProviderSchema,
    status: agentDelegationStatusSchema,
    failure: agentDelegationFailureSchema.optional(),
    failureResetsAt: z.number().int().positive().optional(),
    settledAt: z.number().int().positive().optional(),
    retryOf: identifierSchema.optional(),
    retriedAs: identifierSchema.optional(),
    /**
     * Pending scheduled retry and last refusal; see `agentDelegationReceiptSchema`.
     */
    retryScheduledFor: z.number().int().positive().optional(),
    retryScheduleOutcome: delegationRetryScheduleOutcomeSchema.optional(),
    /**
     * The open question and who it waits on; see `agentDelegationSessionSchema`.
     */
    question: delegationQuestionSummarySchema.optional(),
    waitingOn: delegationWaitingOnSchema.optional(),
    approval: delegationApprovalSummarySchema.optional(),
});

export type AgentDelegationStatusEntry = z.infer<typeof agentDelegationStatusEntrySchema>;

/**
 * How a failed task can be retried. `resume` continues the same Session's native conversation; `fresh` starts the task
 * again in a new Session on the same workbench root.
 */
export const delegationRetryModeSchema = z.enum(['resume', 'fresh']);
export type DelegationRetryMode = z.infer<typeof delegationRetryModeSchema>;

const RETRY_UNAVAILABLE_REASONS = [
    'human_input',
    'target_changed',
    'session_changed',
    'target_busy',
    'no_provider_session',
    'resume_unsupported',
    'caller_gone',
    'worktree_gone',
    'already_retried',
    'not_retryable',
    'no_reset_time',
    'schedule_pending',
] as const;
export type DelegationRetryUnavailableReason = (typeof RETRY_UNAVAILABLE_REASONS)[number];

/**
 * Why a retry mode cannot run now, as a closed enum a Client words itself. Annotated rather than inferred: the method
 * registry's inferred type is at the compiler's serialization limit, and a long inline enum is what it spends it on.
 */
const delegationRetryUnavailableReasonSchema: z.ZodType<DelegationRetryUnavailableReason> =
    z.enum(RETRY_UNAVAILABLE_REASONS);

const delegationRetryOptionSchema = z.strictObject({
    mode: delegationRetryModeSchema,
    /**
     * Always the failed task's provider; a switch to another Agent is listed in `switchTargets`.
     */
    provider: delegationProviderSchema,
    available: z.boolean(),
    unavailableReason: delegationRetryUnavailableReasonSchema.optional(),
});

export type DelegationRetryOption = z.infer<typeof delegationRetryOptionSchema>;

/**
 * Whether a retry can be scheduled for the provider's reset, apart from the two immediate modes. `scheduledFor` is the
 * time it would run (reset plus margin), or the time it runs while one is pending (`schedule_pending`).
 */
export interface DelegationRetrySchedule {
    available: boolean;
    scheduledFor?: number;
    unavailableReason?: DelegationRetryUnavailableReason;
}

/**
 * Annotated rather than inferred, like the reply below: the method registry's inferred type is at the compiler's
 * serialization limit.
 */
const delegationRetryScheduleSchema: z.ZodType<DelegationRetrySchedule> = z.strictObject({
    available: z.boolean(),
    scheduledFor: z.number().int().positive().optional(),
    unavailableReason: delegationRetryUnavailableReasonSchema.optional(),
});

/**
 * The reply of `agent.delegation.retry`: `started` names the new task, `scheduled` the time a pending retry will run. A
 * scheduled reply carries no `sessionId`: no successor Session exists yet.
 */
export type DelegationRetryReply =
    | { status: 'started'; delegationId: string; sessionId: string }
    | { status: 'scheduled'; delegationId: string; scheduledFor: number };

/**
 * Annotated rather than inferred: the method registry's inferred type is at the compiler's serialization limit.
 */
const delegationRetryReplySchema: z.ZodType<DelegationRetryReply> = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('started'),
        delegationId: identifierSchema,
        sessionId: identifierSchema,
    }),
    z.strictObject({
        status: z.literal('scheduled'),
        delegationId: identifierSchema,
        scheduledFor: z.number().int().positive(),
    }),
]);

/**
 * `agent.delegation.cancelScheduledRetry` as a named type. Annotated rather than inferred: the method registry's
 * inferred type is at the compiler's serialization limit, and one more inferred method pushes it over. The literal
 * `owner`, `effect`, and `principal` stay, because the method-type helpers read them. Exported only so the registry's
 * declaration can name it.
 *
 * @public
 */
export interface CancelScheduledRetrySpec extends ReturnType<
    typeof ownerOnlyCommandPolicy<'server', 'control'>
> {
    params: z.ZodType<{ delegationId: string }>;
    result: z.ZodType<{ cancelled: boolean }>;
}

const cancelScheduledRetry: CancelScheduledRetrySpec = {
    ...ownerOnlyCommandPolicy('server', 'control'),
    params: z.strictObject({ delegationId: identifierSchema }),
    result: z.strictObject({ cancelled: z.boolean() }),
};

export const agentDelegationSessionsMethods = {
    ...agentDelegationQuestionMethods,
    ...agentDelegationApprovalMethods,
    ...agentDelegationQuestionOwnerMethods,
    /**
     * The Sessions the named Sessions created, each with its newest delegation's state and stored result, for the
     * Delegated Sessions feed. Owner-only: an Agent Endpoint grant carries the same capability but must not read other
     * Sessions' results. It never claims an unread answer (`markCollected`), so reading the feed does not make a
     * caller's answer evictable before the caller has read it.
     */
    'agent.delegation.sessions': {
        ...ownerOnlyCommandPolicy('server', 'read'),
        params: z.strictObject({
            createdBySessionIds: z.array(identifierSchema).min(1).max(MAX_DELEGATION_CREATORS),
        }),
        result: z.strictObject({
            sessions: z.array(agentDelegationSessionSchema).max(MAX_DELEGATION_SESSIONS),
        }),
    },
    /**
     * The state of each named task, by task ID, for the records a Chat timeline draws where its Agent delegated work.
     * Unlike `agent.delegation.sessions`, which reports the newest task of a Session, this names the exact task, so a
     * record keeps showing the outcome of the task it stands for after a follow-up replaced the Session's newest.
     * Owner-only and non-claiming like the feed; a pruned or unknown ID is absent from the result.
     */
    'agent.delegation.statuses': {
        ...ownerOnlyCommandPolicy('server', 'read'),
        params: z.strictObject({
            delegationIds: z.array(identifierSchema).min(1).max(MAX_DELEGATION_STATUS_IDS),
        }),
        result: z.strictObject({
            statuses: z.array(agentDelegationStatusEntrySchema).max(MAX_DELEGATION_STATUS_IDS),
        }),
    },
    /**
     * Which retry modes the owner may use for one failed task now, for the Retry action's menu. Owner-only and
     * read-only: it changes nothing and claims nothing.
     */
    'agent.delegation.retryOptions': {
        ...ownerOnlyCommandPolicy('server', 'read'),
        params: z.strictObject({ delegationId: identifierSchema }),
        result: z.strictObject({
            options: z.array(delegationRetryOptionSchema).max(2),
            schedule: delegationRetryScheduleSchema,
            /**
             * The Agents a fresh retry could switch to instead of the failed task's own: installed, not at their weekly
             * usage guard, in the static order Claude Code, Codex, then the others. Empty whenever a fresh retry is not
             * available now.
             */
            switchTargets: z.array(delegationProviderSchema).max(agentProviderIds.length),
        }),
    },
    /**
     * Retries one failed task, now or at the provider's reset, as the Agent that delegated it: the new task keeps that
     * Agent's ownership, so it can still `wait` on and read the result. Owner-only (an Agent cannot retry for itself)
     * and idempotent per failed task and operation: the same request again returns the same task or schedule, a
     * different one is a conflict. Without `provider` the failed task's provider is used. `provider` switches a `fresh`
     * retry to another Agent, which launches with that Agent's current delegation settings (no model, effort, or preset
     * carries over); it is allowed only with mode `fresh` and without `scheduleAt`.
     *
     * `scheduleAt: "reset"` holds the claim and runs the retry when the receipt's `failureResetsAt` plus a margin has
     * passed; the Server reads that time itself, so a Client never names one. The reply is then `scheduled`.
     */
    'agent.delegation.retry': {
        ...ownerOnlyCommandPolicy('server', 'control'),
        params: z
            .strictObject({
                delegationId: identifierSchema,
                mode: delegationRetryModeSchema,
                scheduleAt: z.literal('reset').optional(),
                provider: delegationProviderSchema.optional(),
            })
            .refine(
                ({ provider, mode, scheduleAt }) =>
                    provider === undefined || (mode === 'fresh' && scheduleAt === undefined),
                { message: 'provider requires mode fresh and no scheduleAt', path: ['provider'] },
            ),
        result: delegationRetryReplySchema,
    },
    /**
     * Cancels a pending scheduled retry and releases its claim. Idempotent: `cancelled` is false when nothing is
     * pending, including a retry that already started.
     */
    'agent.delegation.cancelScheduledRetry': cancelScheduledRetry,
} as const satisfies Record<string, MethodSpec>;
