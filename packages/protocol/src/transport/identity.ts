import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';

/**
 * Durable Server and State identities use fixed-width random values so they remain opaque, bounded, and safe to include
 * in diagnostics. Boot and Connection identities intentionally share the same wire shape but have distinct semantic
 * fields at every boundary.
 */
export const durableServerIdentitySchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const serverBootIdentitySchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const serverStateEpochSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const serverConnectionIdentitySchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const protocolClientIdentitySchema = identifierSchema;
/**
 * The secret a client presents to reach a Server, and the per-process identity the Server and its Hosts check on every
 * private connection. They live here rather than in `local-transport.ts` because the Terminal Host and Extension Host
 * validate them without loading the whole command registry; see `docs/server-footprint.md`.
 */
export const serverCredentialTokenSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const serverProcessIdentitySchema = z.string().regex(/^[0-9a-f]{32}$/u);

export const protocolFeatureSchema = z.enum([
    'binary-streams-v1',
    'durable-command-receipts-v1',
    'durable-changefeed-v1',
]);

export const protocolFeatures = protocolFeatureSchema.options;

export type ProtocolFeature = z.infer<typeof protocolFeatureSchema>;

export const protocolConnectionIdentitySchema = z
    .object({
        serverId: durableServerIdentitySchema,
        bootId: serverBootIdentitySchema,
        stateEpoch: serverStateEpochSchema,
        clientId: protocolClientIdentitySchema,
        connectionId: serverConnectionIdentitySchema,
    })
    .strict();

export type ProtocolConnectionIdentity = z.infer<typeof protocolConnectionIdentitySchema>;
