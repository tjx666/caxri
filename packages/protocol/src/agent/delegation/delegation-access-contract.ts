import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { commandPolicy } from '../../transport/method-spec.js';
import { delegationProviderSchema } from './agent-delegation-settings.js';

export const delegationAccessParametersSchema = z.strictObject({
    rootPath: z.string().min(1).max(4096),
    callerProvider: delegationProviderSchema,
    registerProject: z.boolean().default(false),
    ttlMs: z.number().int().min(60_000).max(604_800_000).default(43_200_000),
});
const delegationAccessSummarySchema = z.strictObject({
    clientId: z.uuid(),
    generation: z.number().int().positive(),
    projectId: identifierSchema,
    sessionId: identifierSchema,
    callerProvider: delegationProviderSchema,
    createdAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    revokedAt: z.number().int().positive().optional(),
});
export const delegationAccessMethods = {
    'agent.delegation.access.create': {
        ...commandPolicy('server', 'write', ['agents.delegation.access']),
        params: delegationAccessParametersSchema,
        result: delegationAccessSummarySchema.extend({
            token: z.string().regex(/^[a-f0-9]{64}$/u),
        }),
    },
    'agent.delegation.access.list': {
        ...commandPolicy('server', 'read', ['agents.delegation.access']),
        params: z.object({}).default({}),
        result: z.object({ clients: z.array(delegationAccessSummarySchema) }),
    },
    'agent.delegation.access.revoke': {
        ...commandPolicy('server', 'write', ['agents.delegation.access']),
        params: z.strictObject({ clientId: z.uuid(), generation: z.number().int().positive() }),
        result: delegationAccessSummarySchema,
    },
} as const satisfies Record<string, MethodSpec>;

export const delegationAccessInternalMethods = {
    'agent.delegation.access.bootstrap': {
        ...commandPolicy('server', 'write'),
        params: delegationAccessParametersSchema,
        result: z.strictObject({
            projectId: identifierSchema,
            sessionId: identifierSchema,
            callerProvider: delegationProviderSchema,
        }),
    },
} as const satisfies Record<string, MethodSpec>;
