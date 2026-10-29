import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { commandPolicy } from '../../transport/method-spec.js';

/**
 * Largest stored value. API keys, tokens, and passwords are far smaller; a PEM private key still fits.
 */
export const MAX_AGENT_SECRET_VALUE_LENGTH = 16_384;
export const MAX_AGENT_SECRETS = 256;
export const MAX_AGENT_SECRET_REASON_LENGTH = 500;
/**
 * Ceiling of one `agent.secret.wait` long poll. `caxri secret request` polls again until the request settles, so the
 * whole wait is never one long RPC.
 */
export const MAX_AGENT_SECRET_WAIT_MS = 60_000;

/**
 * Names Caxri or the shell already own. A secret under one of them would shadow the launch environment of every command
 * `caxri secret exec` runs, so they are refused at the protocol boundary.
 */
const RESERVED_SECRET_NAMES = new Set([
    'HOME',
    'LOGNAME',
    'PATH',
    'PWD',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
]);

/**
 * A secret is addressed by the environment variable name `caxri secret exec` exports it as, such as
 * `ANTHROPIC_API_KEY`.
 */
export const agentSecretNameSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Z_]\w*$/i, 'Use an environment variable name such as API_TOKEN')
    .refine((name) => !name.toUpperCase().startsWith('CAXRI_'), 'CAXRI_ names are reserved')
    .refine((name) => !RESERVED_SECRET_NAMES.has(name), 'This name is reserved');

export const agentSecretValueSchema = z.string().min(1).max(MAX_AGENT_SECRET_VALUE_LENGTH);

/**
 * `project` secrets reach only Agents running in that Project; `global` secrets reach every Project. A Project secret
 * overrides a global one with the same name.
 */
export const agentSecretScopeSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('project'), projectId: identifierSchema }),
    z.strictObject({ kind: z.literal('global') }),
]);
export type AgentSecretScope = z.infer<typeof agentSecretScopeSchema>;

/**
 * What a client may know about a stored secret. The value never leaves Server Core through a Desktop read: Settings is
 * write-only once saved.
 */
export const agentSecretSummarySchema = z.strictObject({
    name: agentSecretNameSchema,
    scope: agentSecretScopeSchema,
    updatedAt: z.number().int().nonnegative(),
});
export type AgentSecretSummary = z.infer<typeof agentSecretSummarySchema>;

export const agentSecretRequestStatusIds = [
    'pending',
    'saved',
    'declined',
    'expired',
    'cancelled',
] as const;
export type AgentSecretRequestStatus = (typeof agentSecretRequestStatusIds)[number];

/**
 * One Agent's ask for a secret it does not have. `reason` is the Agent's own words, shown to the user as such.
 */
export const agentSecretRequestSchema = z.strictObject({
    id: identifierSchema,
    name: agentSecretNameSchema,
    reason: z.string().min(1).max(MAX_AGENT_SECRET_REASON_LENGTH),
    projectId: identifierSchema,
    sessionId: identifierSchema,
    terminalId: identifierSchema,
    status: z.enum(agentSecretRequestStatusIds),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
});
export type AgentSecretRequest = z.infer<typeof agentSecretRequestSchema>;

const secretRequestAnswerSchema = z.discriminatedUnion('action', [
    z.strictObject({
        action: z.literal('save'),
        value: agentSecretValueSchema,
        scope: z.enum(['project', 'global']),
    }),
    z.strictObject({ action: z.literal('decline') }),
]);

/**
 * Where a secret visible to an Agent comes from; a Project secret shadows a global one of the same name.
 */
const agentVisibleSecretSchema = z.strictObject({
    name: agentSecretNameSchema,
    scope: z.enum(['project', 'global']),
});

const agentSecretWaitStatusSchema = z.strictObject({
    status: z.enum(agentSecretRequestStatusIds),
});

const agentSecretRequestParametersSchema = z.strictObject({
    name: agentSecretNameSchema,
    reason: z.string().trim().min(1).max(MAX_AGENT_SECRET_REASON_LENGTH),
});

/**
 * `available` means the secret already exists for the caller's Project and nobody was asked.
 */
const agentSecretRequestResultSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('available') }),
    z.strictObject({ status: z.literal('pending'), requestId: identifierSchema }),
]);

const resolveParametersSchema = z.strictObject({
    names: z.array(agentSecretNameSchema).min(1).max(32),
});
const resolveResultSchema = z.strictObject({
    values: z.record(agentSecretNameSchema, agentSecretValueSchema),
});

/**
 * The user's own secret store and the requests Agents raise against it. Management is Desktop-only; Agents reach the
 * store through the `agent.secret.*` methods, scoped to their Endpoint's Project.
 */
export const agentSecretMethods = {
    'secrets.list': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({}).default({}),
        result: z.strictObject({
            secrets: z.array(agentSecretSummarySchema).max(MAX_AGENT_SECRETS),
        }),
    },
    /**
     * Saves or replaces one secret. Saving also answers every pending request for that name the new scope covers.
     */
    'secrets.set': {
        ...commandPolicy('server', 'write'),
        params: z.strictObject({
            name: agentSecretNameSchema,
            scope: agentSecretScopeSchema,
            value: agentSecretValueSchema,
        }),
        result: agentSecretSummarySchema,
    },
    'secrets.delete': {
        ...commandPolicy('server', 'write'),
        params: z.strictObject({ name: agentSecretNameSchema, scope: agentSecretScopeSchema }),
        result: z.strictObject({ deleted: z.boolean() }),
    },
    'secrets.requests.list': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({}).default({}),
        result: z.strictObject({ requests: z.array(agentSecretRequestSchema).max(64) }),
    },
    'secrets.requests.answer': {
        ...commandPolicy('server', 'write'),
        params: z.strictObject({ requestId: identifierSchema, answer: secretRequestAnswerSchema }),
        result: agentSecretWaitStatusSchema,
    },
    /**
     * Names the caller's Project can use, never values.
     */
    'agent.secret.list': {
        ...commandPolicy('server', 'read', ['secrets.use']),
        params: z.strictObject({}).default({}),
        result: z.strictObject({
            secrets: z.array(agentVisibleSecretSchema).max(MAX_AGENT_SECRETS),
        }),
    },
    /**
     * Asks the user for a secret the caller's Project lacks. A repeated ask for the same name from the same Terminal
     * joins the pending request instead of raising a second card.
     */
    'agent.secret.request': {
        ...commandPolicy('server', 'control', ['secrets.use']),
        params: agentSecretRequestParametersSchema,
        result: agentSecretRequestResultSchema,
    },
    'agent.secret.wait': {
        ...commandPolicy('server', 'read', ['secrets.use']),
        params: z.strictObject({
            requestId: identifierSchema,
            timeoutMs: z.number().int().min(100).max(MAX_AGENT_SECRET_WAIT_MS).default(30_000),
        }),
        result: agentSecretWaitStatusSchema,
    },
    /**
     * Values for `caxri secret exec`, which exports them to the one child command it runs and never prints them.
     */
    'agent.secret.resolve': {
        ...commandPolicy('server', 'read', ['secrets.use']),
        params: resolveParametersSchema,
        result: resolveResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

const callerSchema = z.strictObject({
    projectId: identifierSchema,
    terminalId: identifierSchema,
});

/**
 * Server Core resolves the caller's Project and Terminal from its authenticated Endpoint; an Agent never names them.
 */
export const agentSecretInternalMethods = {
    'agent.secret.listInternal': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ caller: callerSchema }),
        result: agentSecretMethods['agent.secret.list'].result,
    },
    'agent.secret.requestInternal': {
        ...commandPolicy('server', 'control'),
        params: agentSecretRequestParametersSchema.extend({ caller: callerSchema }),
        result: agentSecretRequestResultSchema,
    },
    'agent.secret.waitInternal': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({
            caller: callerSchema,
            requestId: identifierSchema,
            timeoutMs: z.number().int().min(100).max(MAX_AGENT_SECRET_WAIT_MS),
        }),
        result: agentSecretWaitStatusSchema,
    },
    'agent.secret.resolveInternal': {
        ...commandPolicy('server', 'read'),
        params: resolveParametersSchema.extend({ caller: callerSchema }),
        result: resolveResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;
