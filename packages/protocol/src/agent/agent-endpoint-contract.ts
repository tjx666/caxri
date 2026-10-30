import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { capabilitySchema } from '../transport/principal.js';
import { agentProviderSchema } from './agents.js';

const noParameters = z.object({}).default({});

// eslint-disable-next-line unicorn/name-replacements -- exported schema crosses the public Server protocol boundary; renaming it requires a separately versioned schema change.
export const agentEndpointRefSchema = z.object({
    hostId: identifierSchema,
    endpointId: identifierSchema,
    generation: z.number().int().positive(),
});

export const agentPermissionClassSchema = z.enum(['standard', 'elevated', 'unknown']);
const agentDeliveryModeSchema = z.enum(['push', 'pull', 'unavailable']);
const agentMessagingHealthSchema = z.enum(['ready', 'degraded', 'disabled', 'unsupported']);
const agentMessagingReasonSchema = z.enum([
    'pull_ready',
    'provider_channel_ready',
    'fixture_pull_ready',
    'integration_disabled',
    'provider_missing',
    'version_unsupported',
    'probe_timeout',
    'probe_failed',
    'configuration_conflict',
    'adapter_unavailable',
    'adapter_revoked',
    'probe_pending',
]);
const agentMessagingNextActionSchema = z.enum([
    'use_pull',
    'enable_integration',
    'install_provider',
    'upgrade_provider',
    'fix_configuration',
    'restart_terminal',
    'none',
]);
export const agentMessagingCapabilitySchema = z.strictObject({
    deliveryMode: agentDeliveryModeSchema,
    health: agentMessagingHealthSchema,
    reason: agentMessagingReasonSchema,
    checkedAt: z.number().int().positive(),
    nextAction: agentMessagingNextActionSchema,
    providerVersion: z.string().trim().min(1).max(200).optional(),
});
const agentGrantPolicySchema = z.enum(['debug:read', 'business:write', 'agent:control']);

export const agentEndpointSummarySchema = z.object({
    ref: agentEndpointRefSchema,
    projectId: identifierSchema,
    sessionId: identifierSchema,
    terminalId: identifierSchema,
    provider: agentProviderSchema,
    name: z.string().trim().min(1).max(200),
    permissionClass: agentPermissionClassSchema,
    messaging: agentMessagingCapabilitySchema,
    expiresAt: z.number().int().positive(),
});

const agentEndpointGrantSchema = z.object({
    id: identifierSchema,
    policy: agentGrantPolicySchema,
    grantedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
});

const agentContextResultSchema = z.object({
    status: z.literal('active'),
    endpoint: agentEndpointSummarySchema,
    capabilities: z.array(capabilitySchema).max(64),
    grants: z.array(agentEndpointGrantSchema).max(32),
});

const agentListResultSchema = z.object({
    agents: z.array(agentEndpointSummarySchema).max(128),
});

const endpointTargetParametersSchema = z.object({ endpoint: agentEndpointRefSchema });

export const agentEndpointMethods = {
    'agent.context': {
        ...commandPolicy('server', 'read', ['agents.read']),
        params: noParameters,
        result: agentContextResultSchema,
    },
    'agent.list': {
        ...commandPolicy('server', 'read', ['agents.read']),
        params: noParameters,
        result: agentListResultSchema,
    },
    'agent.grants': {
        ...commandPolicy('server', 'read', ['agents.grant']),
        params: endpointTargetParametersSchema,
        result: z.object({ grants: z.array(agentEndpointGrantSchema).max(32) }),
    },
    'agent.grant': {
        ...commandPolicy('server', 'write', ['agents.grant']),
        params: endpointTargetParametersSchema.extend({
            policy: agentGrantPolicySchema,
            ttlMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
        }),
        result: agentEndpointGrantSchema,
    },
    'agent.revoke': {
        ...commandPolicy('server', 'write', ['agents.grant']),
        params: endpointTargetParametersSchema.extend({ grantId: identifierSchema }),
        result: z.object({ revoked: z.boolean() }),
    },
} as const satisfies Record<string, MethodSpec>;

// eslint-disable-next-line unicorn/name-replacements -- exported type is imported widely across apps/server/src/core and apps/server/src/domains, which is outside this change's authorized file scope.
export type AgentEndpointRef = z.infer<typeof agentEndpointRefSchema>;
export type AgentEndpointSummary = z.infer<typeof agentEndpointSummarySchema>;
export type AgentEndpointGrant = z.infer<typeof agentEndpointGrantSchema>;
export type AgentPermissionClass = z.infer<typeof agentPermissionClassSchema>;
export type AgentMessagingCapability = z.infer<typeof agentMessagingCapabilitySchema>;
export type AgentGrantPolicy = z.infer<typeof agentGrantPolicySchema>;
export type AgentContextResult = z.infer<typeof agentContextResultSchema>;
