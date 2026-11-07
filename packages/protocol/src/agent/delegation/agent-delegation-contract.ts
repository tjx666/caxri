import { z } from 'zod';

import { identifierSchema, pathSchema } from '../../domain/identifiers.js';
import { sessionRenameTitleSchema } from '../../domain/session.js';
import { sessionPullRequestStateSchema } from '../../domain/session-pull-request.js';
import { terminalSurfaceSchema } from '../../domain/terminal-surface.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { commandPolicy } from '../../transport/method-spec.js';
import { principalSchema } from '../../transport/principal.js';
import {
    agentDelegationApprovalInternalMethods,
    delegationStatusResultSchema,
    delegationWaitResultSchema,
} from './agent-delegation-approval-contract.js';
import { agentDelegationQuestionInternalMethods } from './agent-delegation-question-contract.js';
import {
    agentDelegationFailureSchema,
    delegationEffortSchema,
    delegationModelSchema,
    delegationPresetNameSchema,
    delegationProviderSchema,
    delegationRosterSchema,
    delegationSelectionSchema,
    delegationTypeSchema,
} from './agent-delegation-settings.js';
import {
    agentDelegationTranscriptSchema,
    delegationTranscriptParametersSchema as delegationTranscriptParametersSchema,
} from './agent-delegation-transcript.js';
import { agentDelegationUsageSchema } from './agent-delegation-usage.js';
import {
    agentDelegationHistoryInternalMethods,
    agentDelegationHistoryMethods,
} from './history/contract.js';
import {
    hasLaunchSource,
    isHandoverSelectionFree,
    isOneContinuation,
    isOneRelation,
    isPresetExclusive,
    isRelationForNewSession,
    isSurfaceForNewTask,
    isTypeForNewSession,
    isTypeLaunchNamed,
} from './request/create-rules.js';
import { delegationRedirectParametersSchema } from './request/redirect.js';

export const agentDelegationStatusSchema = z.enum([
    'requested',
    'launching',
    'awaiting_ready',
    'submitting',
    'running',
    'collecting',
    'completed',
    'blocked',
    'human_intervened',
    'interrupted',
    'failed',
    'answer_unavailable',
]);

/**
 * Why a scheduled retry did not run at its time, as a closed enum a Client words itself. The refusals mirror
 * `delegationRetryUnavailableReasonSchema`; `missed_window` is a schedule that came due too late, `provider_guarded` a
 * provider still at its weekly usage guard, `launch_failed` a launch the provider refused to start, and
 * `internal_error` an unexpected failure.
 */
export type DelegationRetryScheduleOutcome =
    | 'caller_gone'
    | 'target_busy'
    | 'target_changed'
    | 'human_input'
    | 'worktree_gone'
    | 'not_retryable'
    | 'provider_guarded'
    | 'launch_failed'
    | 'missed_window'
    | 'internal_error';

/**
 * Annotated rather than inferred: the receipt is embedded in many methods, and the method registry's inferred type is
 * at the compiler's serialization limit.
 */
export const delegationRetryScheduleOutcomeSchema: z.ZodType<DelegationRetryScheduleOutcome> =
    z.enum([
        'caller_gone',
        'target_busy',
        'target_changed',
        'human_input',
        'worktree_gone',
        'not_retryable',
        'provider_guarded',
        'launch_failed',
        'missed_window',
        'internal_error',
    ]);

export const agentDelegationReceiptSchema = z.strictObject({
    delegationId: identifierSchema,
    projectId: identifierSchema,
    sessionId: identifierSchema,
    callerTerminalId: identifierSchema.optional(),
    terminalId: identifierSchema.optional(),
    followUpOf: identifierSchema.optional(),
    resumeFrom: identifierSchema.optional(),
    provider: delegationProviderSchema,
    usage: agentDelegationUsageSchema.optional(),
    selection: delegationSelectionSchema.optional(),
    depth: z.number().int().min(1).max(8).optional(),
    parentDelegationId: identifierSchema.optional(),
    /**
     * The failed task this one retries (`agent.delegation.retry`). Set once, at admission. The failed task keeps its
     * own receipt; this link is how a Client and the delegating Agent follow the chain forward.
     */
    retryOf: identifierSchema.optional(),
    /**
     * The task a retry of this failed task runs as. Written as the claim that lets only one retry through, before the
     * new task exists, and cleared again when admission refuses the retry before the new record is inserted. A reader
     * that follows it must tolerate a task pruned since.
     */
    retriedAs: identifierSchema.optional(),
    /**
     * When a scheduled retry of this failed task runs (`agent.delegation.retry` with `scheduleAt`), in epoch
     * milliseconds: the provider's reset time plus a safety margin. Present only while the retry is pending; the claim
     * (`retriedAs`) is held for the whole wait, so a reader must treat `retriedAs` with this field as "retry pending",
     * not as a started task. The task itself stays failed and is not running.
     */
    retryScheduledFor: z.number().int().positive().optional(),
    /**
     * Why the last scheduled retry did not run. Set together with the release of its claim, cleared by the next claim,
     * and never present together with `retriedAs`.
     */
    retryScheduleOutcome: delegationRetryScheduleOutcomeSchema.optional(),
    /**
     * The surface the child Terminal opened on, resolved when the task was admitted: the caller's forced `surface`,
     * else `session.openAgentsInChat` and the provider's Chat support. A caller that needs `transcript` or parent
     * approval reads it instead of guessing. Absent for a hand-over, which continues the user's own Session surface. A
     * follow-up or resume keeps the surface of the task it continues.
     */
    surface: terminalSurfaceSchema.optional(),
    status: agentDelegationStatusSchema,
    failure: agentDelegationFailureSchema.optional(),
    /**
     * How many redirects (`agent.delegation.redirect`) the child's Agent has confirmed taking in, and when the last one
     * arrived (same unit as `createdAt`). Both appear after the first confirmed redirect and never before delivery.
     */
    redirectCount: z.number().int().positive().max(64).optional(),
    redirectedAt: z.number().int().positive().optional(),
    correlationFailure: z
        .enum([
            'native_session_missing',
            'prompt_digest_missing',
            'prompt_digest_mismatch',
            'turn_changed',
            'turn_missing',
            'answer_digest_missing',
            'completion_ambiguous',
        ])
        .optional(),
    /**
     * When the task last left an active status for a settled one (see {@link isDelegationActive}), in the same unit as
     * `createdAt`. `updatedAt` cannot say this: bookkeeping saves (transcript offsets, a claimed answer) move it after
     * the task settled. Absent while the task is active. A follow-up or resume is a new task with its own receipt, so
     * it neither re-activates this receipt nor changes this value.
     */
    settledAt: z.number().int().positive().optional(),
    /**
     * When the failing provider's usage limit resets, in the same unit as `createdAt`. Set only on a task that failed
     * as `quota_exhausted` or `rate_limited` while an authoritative reset time was known (the account usage guard or
     * the failing Chat's own wait); absent when it was not, because a reset time is never guessed.
     */
    failureResetsAt: z.number().int().positive().optional(),
    revision: z.number().int().positive(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
});

/**
 * The receipt as every method returns it. Annotated rather than inferred: the receipt is embedded in many method
 * results, and the method registry's inferred type is at the compiler's serialization limit.
 */
const agentDelegationReceiptResultSchema: z.ZodType<AgentDelegationReceipt> =
    agentDelegationReceiptSchema;

const promptSchema = z
    .string()
    .trim()
    .min(1)
    .max(16_384)
    .refine(
        (value) =>
            new TextEncoder().encode(value).length <= 16_384 &&
            [...value].every((character) => {
                const code = character.codePointAt(0)!;
                return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
            }),
        'Task must be at most 16 KiB and cannot contain terminal control characters',
    );

const agentDelegationCreateFields = {
    projectId: identifierSchema,
    sessionId: identifierSchema,
    provider: delegationProviderSchema.optional(),
    preset: delegationPresetNameSchema.optional(),
    /**
     * A task Caxri knows without configuration (`DELEGATION_TYPES`): the Server picks its Agent from Settings, adds the
     * type's private instructions, and records its new Session as a `consult`. Only with `newSession`, and never with a
     * preset, relation flag, or worktree. A `provider` (with optional model and effort) runs the type on that Agent
     * instead of its binding.
     */
    type: delegationTypeSchema.optional(),
    model: delegationModelSchema.optional(),
    effort: delegationEffortSchema.optional(),
    callerProvider: delegationProviderSchema.optional(),
    prompt: promptSchema,
    followUpOf: identifierSchema.optional(),
    resumeFrom: identifierSchema.optional(),
    /**
     * Starts Caxri Bot's first task in a Session the user handed over, continuing that Session's own Agent conversation
     * (see `botHandoverSchema`). The conversation's provider owns the launch, so it takes no provider, preset, model,
     * or effort; later tasks continue the delegation this one creates.
     */
    continueFromHandover: identifierSchema.optional(),
    /**
     * The caller's Session is done and this task carries its work on in a new Session (the Chat composer's
     * `/new-session`), so the new Session's first message reads as a continuation of the caller's Session rather than
     * an ordinary delegated task. Only with `newSession`.
     */
    handoff: z.literal(true).optional(),
    /**
     * The caller asks a question or review of another Agent in a new Session and changes no files there, so that
     * Session is recorded as a consult (`sessionRelationSchema`). Only with `newSession`, and not together with
     * `handoff`.
     */
    consult: z.literal(true).optional(),
    /**
     * The caller starts a separate Session for its own task and does not wait on it (`independent`): no notice, no
     * roll-up, and its questions go to the user. Only with `newSession`, and not with `handoff` or `consult`.
     */
    independent: z.literal(true).optional(),
    /**
     * Forces the surface the new child Terminal opens on instead of following `session.openAgentsInChat`: `chat` for a
     * child the parent reads with `transcript`, approves, or is asked questions by; `pty` for TUI-only work. A forced
     * `chat` the provider or Server cannot satisfy is refused at admission, never downgraded. Only a new task: a
     * follow-up, resume, or hand-over continues an existing Terminal and keeps its surface.
     */
    surface: terminalSurfaceSchema.optional(),
};

/**
 * A task admitted into one exact Session. This is what the delegation domain stores and authorizes.
 */
export const agentDelegationCreateSchema = z
    .strictObject(agentDelegationCreateFields)
    .refine(isOneContinuation, 'Choose follow-up or exact resume')
    .refine(isPresetExclusive, 'A preset owns its provider, model and effort')
    .refine(isTypeLaunchNamed, 'A model or effort for a type needs its provider')
    .refine(hasLaunchSource, 'Choose a provider, preset or saved task')
    .refine(isSurfaceForNewTask, 'A surface applies to a new task, not a continuation');

/**
 * What a caller sends. `newSession` asks Caxri Bot's own delegation to create the Session it runs in, so the Session
 * first appears with its Agent Terminal already inside instead of sitting empty while Caxri Bot writes the next
 * command. It starts a new task, so it cannot continue a saved one.
 *
 * `title` names that new Session and is required with it. The delegated Agent's first message is only a pointer to the
 * private task file, so automatic naming saw nothing but "read the delegated task" and titled every Caxri Bot Session
 * the same; Caxri Bot, which wrote the task, is the one caller that knows its subject.
 */
export const agentDelegationCreateRequestSchema = z
    .strictObject({
        ...agentDelegationCreateFields,
        /**
         * The Project the new Session joins, as an ID. Exactly one of this and `projectPath`, except that a `type`
         * request may name neither and runs in the Project of the caller's own Session.
         */
        projectId: identifierSchema.optional(),
        /**
         * An absolute folder to add as a visible Project, the way `project.add` does, and delegate into in the same
         * request. Only with `newSession`. Resolved to a Project ID before the Session exists, so the stored task and
         * the Session reference the Project by ID and never carry a root path. The request fingerprint keeps the path,
         * so a replay of the request ID with another folder is a conflict.
         */
        projectPath: pathSchema.optional(),
        sessionId: identifierSchema.optional(),
        newSession: z.literal(true).optional(),
        title: sessionRenameTitleSchema.optional(),
        /**
         * Creates a linked Git worktree of the Project on this new branch and runs the new Session in it, grouped under
         * the Project like a Session the user continued in a worktree.
         */
        worktreeBranch: z.string().trim().min(1).max(200).optional(),
    })
    .refine(isOneContinuation, 'Choose follow-up, exact resume, or a hand-over')
    .refine(isPresetExclusive, 'A preset owns its provider, model and effort')
    .refine(hasLaunchSource, 'Choose a provider, preset or saved task')
    .refine(isHandoverSelectionFree, 'A hand-over keeps its conversation provider and launch')
    .refine(isSurfaceForNewTask, 'A surface applies to a new task, not a continuation')
    .refine(
        (value) => Boolean(value.sessionId) !== Boolean(value.newSession),
        'Choose one Session or a new Session',
    )
    .refine(
        (value) =>
            !value.newSession ||
            (!value.followUpOf && !value.resumeFrom && !value.continueFromHandover),
        'A new Session starts a new task',
    )
    .refine(isRelationForNewSession, 'A hand-off, consult or independent Session is a new Session')
    .refine(
        (value) =>
            !(value.projectId && value.projectPath) &&
            Boolean(value.type ?? value.projectId ?? value.projectPath),
        'Choose a Project ID or a Project path',
    )
    .refine(isTypeForNewSession, 'A type starts its own new Session and decides its relation')
    .refine(
        (value) => !value.projectPath || Boolean(value.newSession),
        'A Project path adds a Project for a new Session',
    )
    .refine(isOneRelation, 'Choose one of hand-off, consult or independent')
    .refine(
        (value) => !value.worktreeBranch || Boolean(value.newSession),
        'A worktree is created for a new Session',
    )
    .refine(
        (value) => Boolean(value.title) === Boolean(value.newSession),
        'Name a new Session with a title; an existing Session keeps its own',
    );

export const agentDelegationAnswerSchema = z.strictObject({
    text: z.string().max(65_536),
    source: z.literal('transcript'),
    messageId: identifierSchema,
    truncated: z.boolean(),
    byteLength: z.number().int().nonnegative(),
});

const identitySchema = z.strictObject({ delegationId: identifierSchema });
const rosterParameters = z.strictObject({
    projectId: identifierSchema,
    sessionId: identifierSchema,
    callerProvider: delegationProviderSchema.optional(),
});
/**
 * Upper bound on the tasks one wait watches, including `delegationId`.
 */
export const MAX_DELEGATION_WAIT_TASKS = 32;
/**
 * Longest single `agent.delegation.wait` long poll. Delegated tasks run for minutes, so this exceeds the 120-second
 * ceiling of other CLI requests; the client transport sets no timer on this method (see `request-lifetime.ts`).
 */
export const MAX_DELEGATION_WAIT_TIMEOUT_MS = 300_000;
const waitParameters = identitySchema.extend({
    /**
     * Further tasks of the same caller to watch. The wait returns the first watched task, in argument order, that has
     * settled or blocked, so an orchestrator running several tasks reacts to whichever needs it first.
     */
    otherDelegationIds: z
        .array(identifierSchema)
        .max(MAX_DELEGATION_WAIT_TASKS - 1)
        .optional(),
    timeoutMs: z.number().int().min(0).max(MAX_DELEGATION_WAIT_TIMEOUT_MS).default(30_000),
    /**
     * Skip the `question` outcome, for a caller that declines to answer and only waits for a task to settle or block.
     */
    ignoreQuestions: z.boolean().optional(),
});
/**
 * Upper bound on the tasks one `list` returns, newest first.
 */
const MAX_DELEGATION_LIST_TASKS = 100;
const listParameters = z.strictObject({
    /**
     * Only tasks still running or blocked, the ones a caller can still wait on or stop.
     */
    active: z.boolean().default(false),
    limit: z.number().int().min(1).max(MAX_DELEGATION_LIST_TASKS).default(20),
});
const listResultSchema = z.strictObject({
    delegations: z.array(agentDelegationReceiptResultSchema).max(MAX_DELEGATION_LIST_TASKS),
    /**
     * More tasks matched than `limit` returned.
     */
    truncated: z.boolean(),
});
/**
 * The pull request Server Core last resolved for the settled task's Session, the same one its sidebar row shows. It is
 * read from that cache and never triggers a GitHub lookup, so a slow or failed lookup cannot delay a result; it is
 * absent while no lookup has seen one yet. It belongs to the Session, not the task: `changedFileCount` counts every
 * file the whole pull request changes (absent when GitHub reported none), not what this one task produced.
 */
const agentDelegationPullRequestSchema = z.strictObject({
    url: z.url(),
    number: z.number().int().positive(),
    state: sessionPullRequestStateSchema,
    changedFileCount: z.number().int().positive().optional(),
});
export type AgentDelegationPullRequest = z.infer<typeof agentDelegationPullRequestSchema>;

const resultSchema = z.strictObject({
    receipt: agentDelegationReceiptResultSchema,
    answer: agentDelegationAnswerSchema.optional(),
    pullRequest: agentDelegationPullRequestSchema.optional(),
});

const waitResultSchema = delegationWaitResultSchema(resultSchema);

/**
 * `status` as every caller reads it; see `AgentDelegationStatusResult`.
 */
const statusResultSchema = delegationStatusResultSchema(agentDelegationReceiptSchema);

export const agentDelegationMethods = {
    ...agentDelegationHistoryMethods,
    'agent.delegation.presets': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: rosterParameters,
        result: delegationRosterSchema,
    },
    'agent.delegation.stop': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: identitySchema,
        result: agentDelegationReceiptResultSchema,
    },
    /**
     * Steers the child's running turn with new direction, as one message in that same turn. Not human input, so it
     * never takes the child over; refused, never queued, when the turn cannot take it now. See
     * `DelegationRedirectRefusal`.
     */
    'agent.delegation.redirect': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: delegationRedirectParametersSchema,
        result: agentDelegationReceiptResultSchema,
    },
    'agent.delegation.create': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: agentDelegationCreateRequestSchema,
        result: agentDelegationReceiptResultSchema,
    },
    'agent.delegation.status': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: identitySchema,
        result: statusResultSchema,
    },
    'agent.delegation.result': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: identitySchema,
        result: resultSchema,
    },
    /**
     * What the caller's own delegated Chat did, page by page; never starts the Agent and never counts as reading the
     * answer. See `agentDelegationTranscriptSchema`.
     */
    'agent.delegation.transcript': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: delegationTranscriptParametersSchema,
        result: agentDelegationTranscriptSchema,
    },
    /**
     * Receipts of the caller's own tasks, so an Agent that lost its context can recover the IDs it started.
     */
    'agent.delegation.list': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: listParameters,
        result: listResultSchema,
    },
    'agent.delegation.wait': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: waitParameters,
        result: waitResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

const authoritySchema = z.strictObject({
    principal: principalSchema,
    callerTerminalId: identifierSchema.optional(),
});

export const agentDelegationInternalMethods = {
    ...agentDelegationHistoryInternalMethods,
    ...agentDelegationQuestionInternalMethods,
    ...agentDelegationApprovalInternalMethods,
    'agent.delegation.presetsInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend(rosterParameters.shape),
        result: delegationRosterSchema,
    },
    'agent.delegation.stopInternal': {
        ...commandPolicy('server', 'control'),
        params: authoritySchema.extend(identitySchema.shape),
        result: agentDelegationReceiptResultSchema,
    },
    'agent.delegation.redirectInternal': {
        ...commandPolicy('server', 'control'),
        params: authoritySchema.extend(delegationRedirectParametersSchema.shape),
        result: agentDelegationReceiptResultSchema,
    },
    'agent.delegation.waitInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend(waitParameters.shape),
        result: agentDelegationMethods['agent.delegation.wait'].result,
    },
    'agent.delegation.createInternal': {
        ...commandPolicy('server', 'control'),
        params: authoritySchema.extend({
            delegationId: identifierSchema,
            input: agentDelegationCreateRequestSchema,
        }),
        result: agentDelegationReceiptResultSchema,
    },
    'agent.delegation.statusInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend({ delegationId: identifierSchema }),
        result: statusResultSchema,
    },
    'agent.delegation.resultInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend({ delegationId: identifierSchema }),
        result: resultSchema,
    },
    'agent.delegation.transcriptInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend(delegationTranscriptParametersSchema.shape),
        result: agentDelegationTranscriptSchema,
    },
    'agent.delegation.listInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend(listParameters.shape),
        result: listResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * An interface rather than a type alias, so declaration emit prints the receipt by name instead of expanding its fields
 * into every method result that carries one (the method registry's inferred type is at the compiler's serialization
 * limit).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the name is the point.
export interface AgentDelegationReceipt extends z.infer<typeof agentDelegationReceiptSchema> {}

/**
 * Shared receipt classification without importing a Server domain's service graph.
 */
export function isDelegationActive(receipt: AgentDelegationReceipt): boolean {
    return [
        'requested',
        'launching',
        'awaiting_ready',
        'submitting',
        'running',
        'collecting',
        'blocked',
    ].includes(receipt.status);
}
export type AgentDelegationAnswer = z.infer<typeof agentDelegationAnswerSchema>;
export type AgentDelegationCreate = z.infer<typeof agentDelegationCreateSchema>;
export type AgentDelegationCreateRequest = z.infer<typeof agentDelegationCreateRequestSchema>;
