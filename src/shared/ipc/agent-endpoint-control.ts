import { z } from 'zod';

import {
    agentDeliveryModeSchema,
    agentEndpointRefSchema,
    agentPermissionClassSchema,
} from '../../../packages/protocol/src/agent-endpoint-contract';
import { agentProviderSchema, identifierSchema } from '../../../packages/protocol/src/domain';
import { wireErrorSchema } from '../../../packages/protocol/src/transport';
import { hostCredentialTokenSchema } from '../../../packages/protocol/src/local-transport';

export const agentEndpointBeginParamsSchema = z.object({
    terminalId: identifierSchema,
    sessionId: identifierSchema,
    projectId: identifierSchema,
    provider: agentProviderSchema,
    launchId: identifierSchema,
    name: z.string().trim().min(1).max(200),
    permissionClass: agentPermissionClassSchema,
    deliveryMode: agentDeliveryModeSchema,
});

export const agentEndpointBeginResultSchema = z.object({
    ref: agentEndpointRefSchema,
    token: hostCredentialTokenSchema,
    expiresAt: z.number().int().positive(),
});

export const agentEndpointRetireParamsSchema = z.object({
    ref: agentEndpointRefSchema,
    launchId: identifierSchema,
});

export const agentEndpointRetireResultSchema = z.object({ retired: z.boolean() });

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
        operation: z.literal('agent-endpoint.retire'),
        params: agentEndpointRetireParamsSchema,
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
export type AgentEndpointRetireParams = z.infer<typeof agentEndpointRetireParamsSchema>;
export type RuntimeHostControlRequest = z.infer<typeof runtimeHostControlRequestSchema>;
