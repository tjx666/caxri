import { z } from 'zod';

import { CaxriError } from './errors.js';
import { protocolConnectionIdentitySchema, protocolFeatureSchema } from './identity.js';
import { capabilitySchema, principalSchema } from './principal.js';

/**
 * Version 2 makes every `files.changed` event carry its immutable Workbench Project scope.
 */
export const CAXRI_PROTOCOL_VERSION = 2 as const;
export const supportedProtocolVersions = [CAXRI_PROTOCOL_VERSION] as const;
export const protocolVersionSchema = z.literal(CAXRI_PROTOCOL_VERSION);

export type CaxriProtocolVersion = typeof CAXRI_PROTOCOL_VERSION;

export const protocolHelloSchema = z.object({
    supportedVersions: z.array(z.number().int().positive()).min(1).max(16),
    features: z.array(protocolFeatureSchema).max(protocolFeatureSchema.options.length).default([]),
});

export const protocolWelcomeSchema = z.object({
    protocolVersion: protocolVersionSchema,
    principal: principalSchema,
    capabilities: z.array(capabilitySchema).max(64),
    /**
     * Bounds a hostile welcome, not the registry: keep it well above the method count, which the protocol contract test
     * asserts against.
     */
    commands: z.array(z.string().min(1).max(120)).max(1024),
    /**
     * Optional on the v2 welcome so a client can feature-gate A4 behavior while connecting to an older same-version
     * development build. Current Servers always send the negotiated list.
     */
    features: z.array(protocolFeatureSchema).max(protocolFeatureSchema.options.length).optional(),
    /**
     * Present when durable recovery was negotiated. Optional keeps an older same-version development build diagnosable
     * while clients fail closed if it advertises a durable feature without the matching identity.
     */
    connection: protocolConnectionIdentitySchema.optional(),
});

export type ProtocolWelcome = z.infer<typeof protocolWelcomeSchema>;

/**
 * Chooses the newest common version without binding negotiation to a concrete transport.
 */
export function negotiateProtocolVersion(clientVersions: readonly number[]): CaxriProtocolVersion {
    const clientVersionSet = new Set(clientVersions);
    for (let index = supportedProtocolVersions.length - 1; index >= 0; index -= 1) {
        const candidate = supportedProtocolVersions[index];
        if (clientVersionSet.has(candidate)) return candidate;
    }
    throw new CaxriError('CONFLICT', 'No compatible Caxri protocol version');
}
