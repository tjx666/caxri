import { z } from 'zod';

import { agentProviderSchema, identifierSchema } from '../domain/domain.js';
import { hostCredentialTokenSchema } from '../transport/local-transport.js';
import { wireErrorSchema } from '../transport/transport.js';
import {
    agentEndpointRefSchema as agentEndpointReferenceSchema,
    agentMessagingCapabilitySchema,
    agentPermissionClassSchema,
} from './agent-endpoint-contract.js';

// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by src/host/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export const agentEndpointBeginParamsSchema = z.object({
    terminalId: identifierSchema,
    sessionId: identifierSchema,
    projectId: identifierSchema,
    provider: agentProviderSchema,
    launchId: identifierSchema,
    name: z.string().trim().min(1).max(200),
    permissionClass: agentPermissionClassSchema,
    messaging: agentMessagingCapabilitySchema,
});

export const agentEndpointBeginResultSchema = z.object({
    ref: agentEndpointReferenceSchema,
    token: hostCredentialTokenSchema,
    expiresAt: z.number().int().positive(),
});

/**
Publishes a prepared credential only after Runtime has a live PTY for this exact launch.
 */
// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by src/host/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export const agentEndpointActivateParamsSchema = z.object({
    ref: agentEndpointReferenceSchema,
    launchId: identifierSchema,
});

export const agentEndpointActivateResultSchema = z.object({ activated: z.boolean() });

// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by src/host/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export const agentEndpointRetireParamsSchema = z.object({
    ref: agentEndpointReferenceSchema,
    launchId: identifierSchema,
});

export const agentEndpointRetireResultSchema = z.object({ retired: z.boolean() });

// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by src/host/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export const agentEndpointMessagingParamsSchema = z.object({
    ref: agentEndpointReferenceSchema,
    launchId: identifierSchema,
    messaging: agentMessagingCapabilitySchema,
});

export const agentEndpointMessagingResultSchema = z.object({ updated: z.boolean() });

export const runtimeHostControlRequestSchema = z.discriminatedUnion('operation', [
    z.object({
        type: z.literal('host-control.request'),
        id: identifierSchema,
        operation: z.literal('agent-endpoint.begin'),
        params: agentEndpointBeginParamsSchema,
    }),
    z.object({
        type: z.literal('host-control.request'),
        id: identifierSchema,
        operation: z.literal('agent-endpoint.activate'),
        params: agentEndpointActivateParamsSchema,
    }),
    z.object({
        type: z.literal('host-control.request'),
        id: identifierSchema,
        operation: z.literal('agent-endpoint.retire'),
        params: agentEndpointRetireParamsSchema,
    }),
    z.object({
        type: z.literal('host-control.request'),
        id: identifierSchema,
        operation: z.literal('agent-endpoint.messaging'),
        params: agentEndpointMessagingParamsSchema,
    }),
]);

export const runtimeHostControlReplySchema = z.discriminatedUnion('ok', [
    z.object({
        type: z.literal('host-control.reply'),
        id: identifierSchema,
        ok: z.literal(true),
        result: z.unknown(),
    }),
    z.object({
        type: z.literal('host-control.reply'),
        id: identifierSchema,
        ok: z.literal(false),
        error: wireErrorSchema,
    }),
]);

// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by src/host/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type AgentEndpointBeginParams = z.infer<typeof agentEndpointBeginParamsSchema>;
export type AgentEndpointBeginResult = z.infer<typeof agentEndpointBeginResultSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by src/host/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type AgentEndpointActivateParams = z.infer<typeof agentEndpointActivateParamsSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by src/host/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type AgentEndpointRetireParams = z.infer<typeof agentEndpointRetireParamsSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by src/host/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type AgentEndpointMessagingParams = z.infer<typeof agentEndpointMessagingParamsSchema>;
export type RuntimeHostControlRequest = z.infer<typeof runtimeHostControlRequestSchema>;
