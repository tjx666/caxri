import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';

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
    provider: z.enum(['claude', 'codex']),
    status: agentDelegationStatusSchema,
    failure: agentDelegationFailureSchema.optional(),
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

export const agentDelegationCreateSchema = z
    .strictObject({
        projectId: identifierSchema,
        sessionId: identifierSchema,
        provider: z.enum(['claude', 'codex']),
        prompt: promptSchema,
        followUpOf: identifierSchema.optional(),
        resumeFrom: identifierSchema.optional(),
    })
    .refine((value) => !(value.followUpOf && value.resumeFrom), 'Choose follow-up or exact resume');

export const agentDelegationAnswerSchema = z.strictObject({
    text: z.string().max(65_536),
    source: z.literal('transcript'),
    messageId: identifierSchema,
    truncated: z.boolean(),
    byteLength: z.number().int().nonnegative(),
});

const identitySchema = z.strictObject({ delegationId: identifierSchema });
const waitParameters = identitySchema.extend({
    timeoutMs: z.number().int().min(0).max(300_000).default(30_000),
});
const resultSchema = z.strictObject({
    receipt: agentDelegationReceiptSchema,
    answer: agentDelegationAnswerSchema.optional(),
});

export const agentDelegationMethods = {
    'agent.delegation.stop': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: identitySchema,
        result: agentDelegationReceiptSchema,
    },
    'agent.delegation.create': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: agentDelegationCreateSchema,
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
            input: agentDelegationCreateSchema,
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
} as const satisfies Record<string, MethodSpec>;

export type AgentDelegationReceipt = z.infer<typeof agentDelegationReceiptSchema>;
export type AgentDelegationAnswer = z.infer<typeof agentDelegationAnswerSchema>;
export type AgentDelegationCreate = z.infer<typeof agentDelegationCreateSchema>;
