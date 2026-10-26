import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';
import { agentEndpointRefSchema as agentEndpointReferenceSchema } from './agent-endpoint-contract.js';
import { agentProviderSchema } from './agents.js';

export const agentDispatchOperationSchema = z.enum(['start', 'resume', 'wake']);
export const agentDispatchStatusSchema = z.enum([
    'requested',
    'starting',
    'running',
    'stopped',
    'interrupted',
    'failed',
]);

/**
 * Auditable launch evidence without exposing provider arguments that may contain local secrets.
 */
export const agentDispatchLaunchSchema = z.strictObject({
    provider: agentProviderSchema,
    mode: z.enum(['fresh', 'resume']),
    executable: z.string().trim().min(1).max(16_384),
    argumentCount: z.number().int().nonnegative().max(256),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const agentDispatchFailureSchema = z.strictObject({
    code: z.enum([
        'VALIDATION',
        'NOT_FOUND',
        'PATH_DENIED',
        'CAPACITY',
        'UNAVAILABLE',
        'TIMEOUT',
        'CANCELLED',
        'CONFLICT',
        'FORBIDDEN',
        'IO',
        'GIT',
        'USAGE_LIMITED',
        'INTERNAL',
    ]),
    reason: z.enum([
        'host_reset',
        'target_changed',
        'provider_session_changed',
        'launch_failed',
        'process_failed',
    ]),
});

export const agentDispatchReceiptSchema = z.strictObject({
    dispatchId: identifierSchema,
    operation: agentDispatchOperationSchema,
    status: agentDispatchStatusSchema,
    projectId: identifierSchema,
    sessionId: identifierSchema,
    terminalId: identifierSchema.optional(),
    provider: agentProviderSchema,
    requestedLaunch: agentDispatchLaunchSchema,
    effectiveLaunch: agentDispatchLaunchSchema,
    endpoint: agentEndpointReferenceSchema.optional(),
    failure: agentDispatchFailureSchema.optional(),
    revision: z.number().int().positive(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
});

const dispatchTargetSchema = z.strictObject({
    projectId: identifierSchema,
    sessionId: identifierSchema,
});

export const agentDispatchStartParametersSchema = dispatchTargetSchema.extend({
    provider: agentProviderSchema,
});

export const agentDispatchResumeParametersSchema = dispatchTargetSchema.extend({
    terminalId: identifierSchema,
    providerSessionId: z.string().trim().min(1).max(1_024),
});

export const agentDispatchStatusParametersSchema = z.strictObject({ dispatchId: identifierSchema });
export const agentDispatchWaitParametersSchema = agentDispatchStatusParametersSchema.extend({
    afterRevision: z.number().int().nonnegative().default(0),
    timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
});

export const agentDispatchWaitResultSchema = z.strictObject({
    receipt: agentDispatchReceiptSchema,
    outcome: z.enum(['changed', 'timed_out', 'canceled']),
});

const agentControlParametersSchema = z.strictObject({ endpoint: agentEndpointReferenceSchema });
export const agentControlResultSchema = z.strictObject({
    endpoint: agentEndpointReferenceSchema,
    terminalId: identifierSchema,
    outcome: z.literal('signaled'),
});

export const MAX_TERMINAL_STEER_BYTES = 8 * 1_024;

function hasUnsafeTerminalControl(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code === 9) continue;
        if (code < 32 || (code >= 127 && code <= 159)) return true;
    }
    return false;
}

export const terminalSendParametersSchema = z.strictObject({
    terminalId: identifierSchema,
    /**
     * Optional optimistic fence used by a remote companion replying to one exact attention event.
     */
    attentionEpoch: z.number().int().nonnegative().optional(),
    text: z
        .string()
        .min(1)
        .refine(
            (value) => new TextEncoder().encode(value).byteLength <= MAX_TERMINAL_STEER_BYTES,
            `Terminal text exceeds ${MAX_TERMINAL_STEER_BYTES} UTF-8 bytes`,
        )
        .refine(
            (value) => !hasUnsafeTerminalControl(value),
            'Terminal text contains control characters; use --enter for Enter',
        ),
    enter: z.boolean().default(false),
});

export const terminalSendResultSchema = z.strictObject({
    terminalId: identifierSchema,
    accepted: z.literal(true),
    byteLength: z.number().int().positive().max(MAX_TERMINAL_STEER_BYTES),
    enter: z.boolean(),
});

export const agentDispatchMethods = {
    'agent.dispatch.start': {
        ...commandPolicy('server', 'control', ['agents.dispatch']),
        params: agentDispatchStartParametersSchema,
        result: agentDispatchReceiptSchema,
    },
    'agent.dispatch.resume': {
        ...commandPolicy('server', 'control', ['agents.dispatch']),
        params: agentDispatchResumeParametersSchema,
        result: agentDispatchReceiptSchema,
    },
    'agent.dispatch.status': {
        ...commandPolicy('server', 'read', ['agents.read']),
        params: agentDispatchStatusParametersSchema,
        result: agentDispatchReceiptSchema,
    },
    'agent.dispatch.wait': {
        ...commandPolicy('server', 'read', ['agents.read']),
        params: agentDispatchWaitParametersSchema,
        result: agentDispatchWaitResultSchema,
    },
    'agent.control.interrupt': {
        ...commandPolicy('server', 'control', ['agents.control']),
        params: agentControlParametersSchema,
        result: agentControlResultSchema,
    },
    'agent.control.stop': {
        ...commandPolicy('server', 'control', ['agents.control']),
        params: agentControlParametersSchema,
        result: agentControlResultSchema,
    },
    'terminal.send': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: terminalSendParametersSchema,
        result: terminalSendResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

const internalIdentitySchema = z.strictObject({
    dispatchId: identifierSchema,
    principal: principalSchema,
});

const projectScopeSchema = z.array(identifierSchema).max(128).nullable();

export const agentDispatchInternalMethods = {
    'agent.dispatch.startInternal': {
        ...commandPolicy('server', 'control'),
        params: internalIdentitySchema.extend({ input: agentDispatchStartParametersSchema }),
        result: agentDispatchReceiptSchema,
    },
    'agent.dispatch.resumeInternal': {
        ...commandPolicy('server', 'control'),
        params: internalIdentitySchema.extend({ input: agentDispatchResumeParametersSchema }),
        result: agentDispatchReceiptSchema,
    },
    'agent.dispatch.wakeInternal': {
        ...commandPolicy('server', 'control'),
        params: internalIdentitySchema.extend({
            target: dispatchTargetSchema.extend({ terminalId: identifierSchema }),
        }),
        result: agentDispatchReceiptSchema,
    },
    'agent.dispatch.statusInternal': {
        ...commandPolicy('server', 'read'),
        params: agentDispatchStatusParametersSchema.extend({ projectScope: projectScopeSchema }),
        result: agentDispatchReceiptSchema,
    },
    'agent.dispatch.waitInternal': {
        ...commandPolicy('server', 'read'),
        params: agentDispatchWaitParametersSchema.extend({
            projectScope: projectScopeSchema,
            waitId: identifierSchema,
        }),
        result: agentDispatchWaitResultSchema,
    },
    'agent.dispatch.cancelWaitInternal': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ waitId: identifierSchema }),
        result: z.strictObject({ canceled: z.boolean() }),
    },
    'agent.control.interruptInternal': {
        ...commandPolicy('server', 'control'),
        params: agentControlParametersSchema,
        result: agentControlResultSchema,
    },
    'agent.control.stopInternal': {
        ...commandPolicy('server', 'control'),
        params: agentControlParametersSchema,
        result: agentControlResultSchema,
    },
    'terminal.sendInternal': {
        ...commandPolicy('server', 'control'),
        params: terminalSendParametersSchema,
        result: terminalSendResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type AgentDispatchOperation = z.infer<typeof agentDispatchOperationSchema>;
export type AgentDispatchStatus = z.infer<typeof agentDispatchStatusSchema>;
export type AgentDispatchLaunch = z.infer<typeof agentDispatchLaunchSchema>;
export type AgentDispatchFailure = z.infer<typeof agentDispatchFailureSchema>;
export type AgentDispatchReceipt = z.infer<typeof agentDispatchReceiptSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported type is imported by apps/server/src/domains/agent-dispatch/service.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type AgentDispatchStartParams = z.infer<typeof agentDispatchStartParametersSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported type is imported by apps/server/src/domains/agent-dispatch/service.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type AgentDispatchResumeParams = z.infer<typeof agentDispatchResumeParametersSchema>;
export type AgentDispatchWaitResult = z.infer<typeof agentDispatchWaitResultSchema>;
