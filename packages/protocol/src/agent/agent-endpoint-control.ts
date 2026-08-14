import { z } from 'zod';

import {
    agentEndpointRefSchema,
    agentMessagingCapabilitySchema,
    agentPermissionClassSchema,
} from './agent-endpoint-contract.js';
import { agentProviderSchema, identifierSchema } from '../domain/domain.js';
import { hostCredentialTokenSchema } from '../transport/local-transport.js';
import { wireErrorSchema } from '../transport/transport.js';

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
    ref: agentEndpointRefSchema,
    token: hostCredentialTokenSchema,
    expiresAt: z.number().int().positive(),
});

/** Publishes a prepared credential only after Runtime has a live PTY for this exact launch. */
export const agentEndpointActivateParamsSchema = z.object({
    ref: agentEndpointRefSchema,
    launchId: identifierSchema,
});

export const agentEndpointActivateResultSchema = z.object({ activated: z.boolean() });

export const agentEndpointRetireParamsSchema = z.object({
    ref: agentEndpointRefSchema,
    launchId: identifierSchema,
});

export const agentEndpointRetireResultSchema = z.object({ retired: z.boolean() });

export const agentEndpointMessagingParamsSchema = z.object({
    ref: agentEndpointRefSchema,
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

export type AgentEndpointBeginParams = z.infer<typeof agentEndpointBeginParamsSchema>;
export type AgentEndpointBeginResult = z.infer<typeof agentEndpointBeginResultSchema>;
export type AgentEndpointActivateParams = z.infer<typeof agentEndpointActivateParamsSchema>;
export type AgentEndpointRetireParams = z.infer<typeof agentEndpointRetireParamsSchema>;
export type AgentEndpointMessagingParams = z.infer<typeof agentEndpointMessagingParamsSchema>;
export type RuntimeHostControlRequest = z.infer<typeof runtimeHostControlRequestSchema>;
