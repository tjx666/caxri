import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { serverCredentialTokenSchema } from '../transport/identity.js';
import {
    agentEndpointRefSchema as agentEndpointReferenceSchema,
    agentMessagingCapabilitySchema,
    agentPermissionClassSchema,
} from './agent-endpoint-contract.js';
import { agentProviderSchema } from './agents.js';

// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by apps/server/src/core/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export const agentEndpointBeginParamsSchema = z.object({
    terminalId: identifierSchema,
    sessionId: identifierSchema,
    projectId: identifierSchema,
    provider: agentProviderSchema,
    launchId: identifierSchema,
    name: z.string().trim().min(1).max(200),
    permissionClass: agentPermissionClassSchema,
    messaging: agentMessagingCapabilitySchema,
    /**
     * Set only by domain services for the Caxri Bot Terminal they own; it adds the fixed Caxri Bot capabilities.
     */
    role: z.literal('bot').optional(),
});

export const agentEndpointBeginResultSchema = z.object({
    ref: agentEndpointReferenceSchema,
    token: serverCredentialTokenSchema,
    expiresAt: z.number().int().positive(),
});

/**
 * Publishes a prepared credential only after Runtime has a live PTY for this exact launch.
 */
// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by apps/server/src/core/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export const agentEndpointActivateParamsSchema = z.object({
    ref: agentEndpointReferenceSchema,
    launchId: identifierSchema,
});

// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by apps/server/src/core/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export const agentEndpointRetireParamsSchema = z.object({
    ref: agentEndpointReferenceSchema,
    launchId: identifierSchema,
});

// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by apps/server/src/core/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export const agentEndpointMessagingParamsSchema = z.object({
    ref: agentEndpointReferenceSchema,
    launchId: identifierSchema,
    messaging: agentMessagingCapabilitySchema,
});

// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by apps/server/src/core/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type AgentEndpointBeginParams = z.infer<typeof agentEndpointBeginParamsSchema>;
export type AgentEndpointBeginResult = z.infer<typeof agentEndpointBeginResultSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by apps/server/src/core/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type AgentEndpointActivateParams = z.infer<typeof agentEndpointActivateParamsSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by apps/server/src/core/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type AgentEndpointRetireParams = z.infer<typeof agentEndpointRetireParamsSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported symbol is imported by apps/server/src/core/agent-endpoints/registry.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type AgentEndpointMessagingParams = z.infer<typeof agentEndpointMessagingParamsSchema>;
