import { z } from 'zod';

import { agentProviderSchema, identifierSchema } from './domain.js';
import { commandPolicy, type MethodSpec } from './method-spec.js';
import { capabilitySchema } from './principal.js';

const noParams = z.object({}).default({});

export const agentEndpointRefSchema = z.object({
    hostId: identifierSchema,
    endpointId: identifierSchema,
    generation: z.number().int().positive(),
});

export const agentPermissionClassSchema = z.enum(['standard', 'elevated', 'unknown']);
export const agentDeliveryModeSchema = z.enum(['push', 'pull', 'unavailable']);
export const agentGrantPolicySchema = z.enum(['debug:read', 'business:write', 'agent:control']);

export const agentEndpointSummarySchema = z.object({
    ref: agentEndpointRefSchema,
    projectId: identifierSchema,
    sessionId: identifierSchema,
    terminalId: identifierSchema,
    provider: agentProviderSchema,
    name: z.string().trim().min(1).max(200),
    permissionClass: agentPermissionClassSchema,
    deliveryMode: agentDeliveryModeSchema,
    expiresAt: z.number().int().positive(),
});

export const agentEndpointGrantSchema = z.object({
    id: identifierSchema,
    policy: agentGrantPolicySchema,
    grantedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
});

export const agentContextResultSchema = z.object({
    status: z.literal('active'),
    endpoint: agentEndpointSummarySchema,
    capabilities: z.array(capabilitySchema).max(64),
    grants: z.array(agentEndpointGrantSchema).max(32),
});

export const agentListResultSchema = z.object({
    agents: z.array(agentEndpointSummarySchema).max(128),
});

const endpointTargetParamsSchema = z.object({ endpoint: agentEndpointRefSchema });

export const agentEndpointMethods = {
    'agent.context': {
        ...commandPolicy('host', 'read', ['agents.read']),
        params: noParams,
        result: agentContextResultSchema,
    },
    'agent.list': {
        ...commandPolicy('host', 'read', ['agents.read']),
        params: noParams,
        result: agentListResultSchema,
    },
    'agent.grants': {
        ...commandPolicy('host', 'read', ['agents.grant']),
        params: endpointTargetParamsSchema,
        result: z.object({ grants: z.array(agentEndpointGrantSchema).max(32) }),
    },
    'agent.grant': {
        ...commandPolicy('host', 'write', ['agents.grant']),
        params: endpointTargetParamsSchema.extend({
            policy: agentGrantPolicySchema,
            ttlMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
        }),
        result: agentEndpointGrantSchema,
    },
    'agent.revoke': {
        ...commandPolicy('host', 'write', ['agents.grant']),
        params: endpointTargetParamsSchema.extend({ grantId: identifierSchema }),
        result: z.object({ revoked: z.boolean() }),
    },
} as const satisfies Record<string, MethodSpec>;

export type AgentEndpointRef = z.infer<typeof agentEndpointRefSchema>;
export type AgentEndpointSummary = z.infer<typeof agentEndpointSummarySchema>;
export type AgentEndpointGrant = z.infer<typeof agentEndpointGrantSchema>;
export type AgentPermissionClass = z.infer<typeof agentPermissionClassSchema>;
export type AgentDeliveryMode = z.infer<typeof agentDeliveryModeSchema>;
export type AgentGrantPolicy = z.infer<typeof agentGrantPolicySchema>;
export type AgentContextResult = z.infer<typeof agentContextResultSchema>;
