import { z } from 'zod';

import { sessionRelationSchema } from '../../domain/domain.js';
import { identifierSchema } from '../../domain/identifiers.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { ownerOnlyCommandPolicy } from '../../transport/method-spec.js';
import {
    agentDelegationFailureSchema,
    agentDelegationStatusSchema,
} from './agent-delegation-contract.js';
import { delegationProviderSchema } from './agent-delegation-settings.js';

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
    status: agentDelegationStatusSchema.optional(),
    failure: agentDelegationFailureSchema.optional(),
    failureResetsAt: z.number().int().positive().optional(),
    /**
     * The failed task this one retries, and the task a retry of this failed one runs as; see
     * `agentDelegationReceiptSchema`. Either may name a task pruned since.
     */
    retryOf: identifierSchema.optional(),
    retriedAs: identifierSchema.optional(),
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
});

export type AgentDelegationStatusEntry = z.infer<typeof agentDelegationStatusEntrySchema>;

/**
 * How a failed task can be retried. `resume` continues the same Session's native conversation; `fresh` starts the task
 * again in a new Session on the same workbench root.
 */
export const delegationRetryModeSchema = z.enum(['resume', 'fresh']);
export type DelegationRetryMode = z.infer<typeof delegationRetryModeSchema>;

/**
 * Why a retry mode cannot run now, as a closed enum a Client words itself.
 */
const delegationRetryUnavailableReasonSchema = z.enum([
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
]);
export type DelegationRetryUnavailableReason = z.infer<
    typeof delegationRetryUnavailableReasonSchema
>;

const delegationRetryOptionSchema = z.strictObject({
    mode: delegationRetryModeSchema,
    /**
     * Always the failed task's provider: a retry never switches provider.
     */
    provider: delegationProviderSchema,
    available: z.boolean(),
    unavailableReason: delegationRetryUnavailableReasonSchema.optional(),
});

export type DelegationRetryOption = z.infer<typeof delegationRetryOptionSchema>;

export const agentDelegationSessionsMethods = {
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
        result: z.strictObject({ options: z.array(delegationRetryOptionSchema).max(2) }),
    },
    /**
     * Retries one failed task now, as the Agent that delegated it: the new task keeps that Agent's ownership, so it can
     * still `wait` on and read the result. Owner-only (an Agent cannot retry for itself) and idempotent per failed task
     * and mode: the same mode again returns the same new task, the other mode is a conflict. It takes no provider; the
     * failed task's provider is always used.
     */
    'agent.delegation.retry': {
        ...ownerOnlyCommandPolicy('server', 'control'),
        params: z.strictObject({
            delegationId: identifierSchema,
            mode: delegationRetryModeSchema,
        }),
        result: z.strictObject({ delegationId: identifierSchema, sessionId: identifierSchema }),
    },
} as const satisfies Record<string, MethodSpec>;
