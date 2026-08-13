import { z } from 'zod';

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
    'terminals.control',
    'files.read',
    'files.write',
    'git.read',
    'git.control',
    'settings.read',
    'settings.write',
    'diagnostics.read',
    'agents.read',
    'agents.message',
    'agents.dispatch',
    'agents.control',
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
        projectIds: projectIdsSchema,
    }),
]);

export type Principal = z.infer<typeof principalSchema>;

export interface CommandExecutionContext {
    capabilities: readonly Capability[];
    principal: Principal;
}

/** Desktop is the local owner principal; every other principal needs each declared capability. */
export function hasRequiredCapabilities(
    context: CommandExecutionContext,
    required: readonly Capability[],
): boolean {
    if (context.principal.kind === 'desktop' && context.capabilities.includes('desktop'))
        return true;
    const granted = new Set(context.capabilities);
    return required.every((capability) => granted.has(capability));
}
