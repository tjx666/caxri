import { z } from 'zod';

import { CaxriError } from './errors.js';
import { capabilitySchema, principalSchema } from './principal.js';

/** Version 2 makes every `files.changed` event carry its immutable Workbench Project scope. */
export const CAXRI_PROTOCOL_VERSION = 2 as const;
export const supportedProtocolVersions = [CAXRI_PROTOCOL_VERSION] as const;
export const protocolVersionSchema = z.literal(CAXRI_PROTOCOL_VERSION);

export type CaxriProtocolVersion = typeof CAXRI_PROTOCOL_VERSION;

export const protocolHelloSchema = z.object({
    supportedVersions: z.array(z.number().int().positive()).min(1).max(16),
});

export const protocolWelcomeSchema = z.object({
    protocolVersion: protocolVersionSchema,
    principal: principalSchema,
    capabilities: z.array(capabilitySchema).max(64),
    commands: z.array(z.string().min(1).max(120)).max(256),
});

export type ProtocolHello = z.infer<typeof protocolHelloSchema>;
export type ProtocolWelcome = z.infer<typeof protocolWelcomeSchema>;

/** Chooses the newest common version without binding negotiation to a concrete transport. */
export function negotiateProtocolVersion(clientVersions: readonly number[]): CaxriProtocolVersion {
    const clientVersionSet = new Set(clientVersions);
    const version = [...supportedProtocolVersions]
        .reverse()
        .find((candidate) => clientVersionSet.has(candidate));
    if (!version) throw new CaxriError('CONFLICT', 'No compatible Caxri protocol version');
    return version;
}
