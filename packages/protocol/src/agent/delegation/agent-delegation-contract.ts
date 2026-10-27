import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';
import { sessionRenameTitleSchema } from '../../domain/session.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { commandPolicy } from '../../transport/method-spec.js';
import { principalSchema } from '../../transport/principal.js';
import {
    delegationEffortSchema,
    delegationModelSchema,
    delegationPresetNameSchema,
    delegationProviderSchema,
    delegationRosterSchema,
    delegationSelectionSchema,
} from './agent-delegation-settings.js';
import { agentDelegationUsageSchema } from './agent-delegation-usage.js';

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

export const agentDelegationFailureSchema = z.enum([
    'rate_limited',
    'authentication_failed',
    'output_limit',
    'startup_not_ready',
    /**
     * With status `blocked`: the Agent process is alive but has not started its turn after the startup deadline,
     * usually because a first-run prompt (folder trust, sign-in, an update notice) waits for the user in its Terminal.
     * The task resumes on its own once the Agent starts; the prompt's content is never read.
     */
    'startup_waiting',
    'submission_unconfirmed',
    'provider_failed',
    'permission_required',
    'target_changed',
    'session_changed',
    'human_input',
    'host_reset',
    'result_missing',
    'payload_overflow',
    'launch_failed',
    'correlation_missing',
    'quota_exhausted',
    'caller_stopped',
    'target_not_ready',
    'target_busy',
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
    status: agentDelegationStatusSchema,
    failure: agentDelegationFailureSchema.optional(),
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
    revision: z.number().int().positive(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
});

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
};

type DelegationCreateShape = Partial<
    Record<
        | 'continueFromHandover'
        | 'effort'
        | 'followUpOf'
        | 'model'
        | 'preset'
        | 'provider'
        | 'resumeFrom',
        unknown
    >
>;

const isOneContinuation = (value: DelegationCreateShape) =>
    [value.followUpOf, value.resumeFrom, value.continueFromHandover].filter(Boolean).length <= 1;
const isPresetExclusive = (value: DelegationCreateShape) =>
    !value.preset || (!value.provider && !value.model && !value.effort);
const hasLaunchSource = (value: DelegationCreateShape) =>
    Boolean(
        value.provider ??
        value.preset ??
        value.followUpOf ??
        value.resumeFrom ??
        value.continueFromHandover,
    );
/**
 * A hand-over continues an existing conversation, whose provider and launch are already fixed.
 */
const isHandoverSelectionFree = (value: DelegationCreateShape) =>
    !value.continueFromHandover ||
    (!value.provider && !value.preset && !value.model && !value.effort);

/**
 * A task admitted into one exact Session. This is what the delegation domain stores and authorizes.
 */
export const agentDelegationCreateSchema = z
    .strictObject(agentDelegationCreateFields)
    .refine(isOneContinuation, 'Choose follow-up or exact resume')
    .refine(isPresetExclusive, 'A preset owns its provider, model and effort')
    .refine(hasLaunchSource, 'Choose a provider, preset or saved task');

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
        sessionId: identifierSchema.optional(),
        newSession: z.literal(true).optional(),
        title: sessionRenameTitleSchema.optional(),
    })
    .refine(isOneContinuation, 'Choose follow-up, exact resume, or a hand-over')
    .refine(isPresetExclusive, 'A preset owns its provider, model and effort')
    .refine(hasLaunchSource, 'Choose a provider, preset or saved task')
    .refine(isHandoverSelectionFree, 'A hand-over keeps its conversation provider and launch')
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
    .refine(
        (value) => !value.handoff || Boolean(value.newSession),
        'A hand-off continues in a new Session',
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
});
/**
 * Upper bound on the tasks one `list` returns, newest first.
 */
export const MAX_DELEGATION_LIST_TASKS = 100;
const listParameters = z.strictObject({
    /**
     * Only tasks still running or blocked, the ones a caller can still wait on or stop.
     */
    active: z.boolean().default(false),
    limit: z.number().int().min(1).max(MAX_DELEGATION_LIST_TASKS).default(20),
});
const listResultSchema = z.strictObject({
    delegations: z.array(agentDelegationReceiptSchema).max(MAX_DELEGATION_LIST_TASKS),
    /**
     * More tasks matched than `limit` returned.
     */
    truncated: z.boolean(),
});
const resultSchema = z.strictObject({
    receipt: agentDelegationReceiptSchema,
    answer: agentDelegationAnswerSchema.optional(),
});

export const agentDelegationMethods = {
    'agent.delegation.presets': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: rosterParameters,
        result: delegationRosterSchema,
    },
    'agent.delegation.stop': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: identitySchema,
        result: agentDelegationReceiptSchema,
    },
    'agent.delegation.create': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: agentDelegationCreateRequestSchema,
        result: agentDelegationReceiptSchema,
    },
    'agent.delegation.status': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: identitySchema,
        result: agentDelegationReceiptSchema,
    },
    'agent.delegation.result': {
        ...commandPolicy('server', 'read', ['agents.delegate']),
        params: identitySchema,
        result: resultSchema,
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
        result: resultSchema.extend({ outcome: z.enum(['settled', 'blocked', 'timeout']) }),
    },
} as const satisfies Record<string, MethodSpec>;

const authoritySchema = z.strictObject({
    principal: principalSchema,
    callerTerminalId: identifierSchema.optional(),
});

export const agentDelegationInternalMethods = {
    'agent.delegation.presetsInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend(rosterParameters.shape),
        result: delegationRosterSchema,
    },
    'agent.delegation.stopInternal': {
        ...commandPolicy('server', 'control'),
        params: authoritySchema.extend(identitySchema.shape),
        result: agentDelegationReceiptSchema,
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
        result: agentDelegationReceiptSchema,
    },
    'agent.delegation.statusInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend({ delegationId: identifierSchema }),
        result: agentDelegationReceiptSchema,
    },
    'agent.delegation.resultInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend({ delegationId: identifierSchema }),
        result: resultSchema,
    },
    'agent.delegation.listInternal': {
        ...commandPolicy('server', 'read'),
        params: authoritySchema.extend(listParameters.shape),
        result: listResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type AgentDelegationReceipt = z.infer<typeof agentDelegationReceiptSchema>;

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
