import { z } from 'zod';

import { delegationProviderSchema } from '../agent/delegation/agent-delegation-settings.js';
import { mobileDeviceRoleSchema } from '../mobile/device-role.js';
import type { ProtocolConnectionIdentity } from './identity.js';

export const capabilityIds = [
    'desktop',
    'host.read',
    'host.stop',
    'events.read',
    'projects.read',
    'projects.write',
    'sessions.read',
    'sessions.write',
    'terminals.read',
    'terminals.preview',
    'terminals.control',
    'terminals.steer',
    'files.read',
    'files.write',
    'git.read',
    'git.control',
    'settings.read',
    'settings.write',
    'settings.delegation.write',
    'diagnostics.read',
    'agents.read',
    'agents.message',
    'agents.dispatch',
    'agents.delegate',
    'agents.delegation.access',
    'agents.control',
    'agents.grant',
    'secrets.use',
    'bot',
    'desktop.window',
] as const;

export const capabilitySchema = z.enum(capabilityIds);
export type Capability = z.infer<typeof capabilitySchema>;

const principalIdSchema = z.string().min(1).max(200);
const projectIdsSchema = z.array(principalIdSchema).max(128).default([]);

export const principalSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('desktop'),
        id: principalIdSchema,
        generation: z.number().int().positive(),
    }),
    z.object({ kind: z.literal('human-cli'), id: principalIdSchema }),
    z.object({
        kind: z.literal('delegation-client'),
        id: principalIdSchema,
        clientId: principalIdSchema,
        generation: z.number().int().positive(),
        projectIds: z.tuple([principalIdSchema]),
        sessionId: principalIdSchema,
        callerProvider: delegationProviderSchema,
    }),
    z.object({
        kind: z.literal('extension'),
        id: principalIdSchema,
        extensionId: principalIdSchema,
        generation: z.number().int().positive(),
        projectIds: projectIdsSchema,
    }),
    z.object({
        kind: z.literal('agent'),
        id: principalIdSchema,
        endpointId: principalIdSchema,
        generation: z.number().int().nonnegative(),
        projectIds: projectIdsSchema,
    }),
    z.object({
        kind: z.literal('paired-device'),
        id: principalIdSchema,
        deviceId: principalIdSchema,
        generation: z.number().int().positive(),
        role: mobileDeviceRoleSchema,
        projectIds: projectIdsSchema,
    }),
]);

export type Principal = z.infer<typeof principalSchema>;

export interface CommandExecutionContext {
    capabilities: readonly Capability[];
    connection?: ProtocolConnectionIdentity;
    principal: Principal;
}

/**
 * Desktop is the local owner principal; every other principal, including a bundled extension, needs each declared
 * capability. An extension must never inherit the Desktop bypass merely because both execute on the same machine.
 */
export function hasRequiredCapabilities(
    context: CommandExecutionContext,
    required: readonly Capability[],
): boolean {
    if (context.principal.kind === 'desktop' && context.capabilities.includes('desktop'))
        return true;
    const granted = new Set(context.capabilities);
    return required.every((capability) => granted.has(capability));
}
