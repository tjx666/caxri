import { z } from 'zod';

import { identifierSchema, pathSchema } from './domain.js';
import { protocolEventEnvelopeSchema } from './event-journal.js';
import { runtimeEventSchema } from './events.js';
import { commandReplyEnvelopeSchema, requestEnvelopeSchema } from './transport.js';
import { protocolHelloSchema, protocolWelcomeSchema } from './version.js';

export const HOST_MANIFEST_VERSION = 1 as const;
export const hostOwnerTokenSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const hostProcessIdentitySchema = z.string().regex(/^[0-9a-f]{32}$/u);

/** Private profile discovery record. The credential must never appear in status or diagnostics. */
export const hostManifestSchema = z.object({
    manifestVersion: z.literal(HOST_MANIFEST_VERSION),
    profileId: identifierSchema,
    endpoint: pathSchema.max(103),
    pid: z.number().int().positive(),
    startedAt: z.number().int().positive(),
    processIdentity: hostProcessIdentitySchema,
    /** Kept open so an older client can report a clean incompatibility instead of a corrupt file. */
    protocolVersion: z.number().int().positive(),
    version: z.string().min(1).max(100),
    ownerToken: hostOwnerTokenSchema,
});

export type HostManifest = z.infer<typeof hostManifestSchema>;

export const hostLockSchema = hostManifestSchema.pick({
    pid: true,
    startedAt: true,
    processIdentity: true,
    profileId: true,
});

export type HostLock = z.infer<typeof hostLockSchema>;

export const localClientHelloSchema = protocolHelloSchema.extend({
    type: z.literal('hello'),
    profileId: identifierSchema,
    ownerToken: hostOwnerTokenSchema,
    clientKind: z.enum(['desktop', 'human-cli']),
});

export const localServerWelcomeSchema = protocolWelcomeSchema.extend({
    type: z.literal('welcome'),
    profileId: identifierSchema,
    processIdentity: hostProcessIdentitySchema,
});

export const localClientCommandSchema = z.object({
    type: z.literal('command'),
    request: requestEnvelopeSchema,
});

export const localServerReplySchema = z.object({
    type: z.literal('reply'),
    reply: commandReplyEnvelopeSchema,
});

export const localServerEventSchema = z.object({
    type: z.literal('event'),
    event: z.union([protocolEventEnvelopeSchema, runtimeEventSchema]),
});

export type LocalClientHello = z.infer<typeof localClientHelloSchema>;
export type LocalServerWelcome = z.infer<typeof localServerWelcomeSchema>;
export type LocalClientCommand = z.infer<typeof localClientCommandSchema>;
export type LocalServerReply = z.infer<typeof localServerReplySchema>;
export type LocalServerEvent = z.infer<typeof localServerEventSchema>;
