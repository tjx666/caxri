import { z } from 'zod';

import { isDesktopRuntimeMethod } from '../desktop/desktop-runtime.js';
import { identifierSchema, pathSchema } from '../domain/domain.js';
import { protocolEventEnvelopeSchema, transientRuntimeEventSchema } from './event-journal.js';
import { commandReplyEnvelopeSchema, requestEnvelopeSchema } from './transport.js';
import { protocolHelloSchema, protocolVersionSchema, protocolWelcomeSchema } from './version.js';

export const HOST_MANIFEST_VERSION = 2 as const;
export const HOST_DESKTOP_CREDENTIAL_VERSION = 1 as const;
/**
 * One authenticated control message can contain two 16 MiB editor buffers. The extra headroom covers worst-case JSON
 * escaping while keeping a malformed peer under a fixed memory cap.
 */
export const CONTROL_TRANSPORT_MAX_FRAME_BYTES = 256 * 1024 * 1024;
export const hostCredentialTokenSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const hostProcessIdentitySchema = z.string().regex(/^[0-9a-f]{32}$/u);

export const hostControlEndpointSchema = z.object({
    protocol: z.literal('ws'),
    host: z.literal('127.0.0.1'),
    port: z.number().int().positive().max(65_535),
    path: z.literal('/control'),
});

export type HostControlEndpoint = z.infer<typeof hostControlEndpointSchema>;

export function hostEndpointUrl(endpoint: HostControlEndpoint): string {
    return `ws://${endpoint.host}:${endpoint.port}${endpoint.path}`;
}

export const hostManifestIdentitySchema = z.object({
    profileId: identifierSchema,
    pid: z.number().int().positive(),
    startedAt: z.number().int().positive(),
    processIdentity: hostProcessIdentitySchema,
    /**
     * Kept open so an incompatible client can report a clean error instead of treating the discovery record as corrupt.
     */
    protocolVersion: z.number().int().positive(),
    version: z.string().min(1).max(100),
    operatorToken: hostCredentialTokenSchema,
});

export type HostManifestIdentity = z.infer<typeof hostManifestIdentitySchema>;

/**
 * Private profile discovery record. The credential must never appear in status or diagnostics.
 */
export const hostManifestSchema = hostManifestIdentitySchema.extend({
    manifestVersion: z.literal(HOST_MANIFEST_VERSION),
    endpoint: hostControlEndpointSchema,
});

export type HostManifest = z.infer<typeof hostManifestSchema>;

export const hostLockSchema = hostManifestIdentitySchema.pick({
    pid: true,
    startedAt: true,
    processIdentity: true,
    profileId: true,
});

export type HostLock = z.infer<typeof hostLockSchema>;

/**
 * Separate Desktop credential. It is never exposed through the operator discovery manifest.
 */
export const hostDesktopCredentialSchema = z.object({
    credentialVersion: z.literal(HOST_DESKTOP_CREDENTIAL_VERSION),
    profileId: identifierSchema,
    processIdentity: hostProcessIdentitySchema,
    desktopToken: hostCredentialTokenSchema,
});

export type HostDesktopCredential = z.infer<typeof hostDesktopCredentialSchema>;

export const desktopLeaseSchema = z.object({
    desktopId: identifierSchema,
    generation: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
});

export type DesktopLease = z.infer<typeof desktopLeaseSchema>;

const localClientOperatorCredentialSchema = z.object({
    kind: z.literal('operator'),
    token: hostCredentialTokenSchema,
});

const localClientAgentCredentialSchema = z.object({
    kind: z.literal('agent'),
    hostId: hostProcessIdentitySchema,
    endpointId: identifierSchema,
    generation: z.number().int().positive(),
    token: hostCredentialTokenSchema,
});

const localClientDesktopCredentialSchema = z.object({
    kind: z.literal('desktop'),
    token: hostCredentialTokenSchema,
    desktopId: identifierSchema,
});

export const localClientHelloSchema = protocolHelloSchema.extend({
    type: z.literal('hello'),
    profileId: identifierSchema,
    credential: z.discriminatedUnion('kind', [
        localClientOperatorCredentialSchema,
        localClientAgentCredentialSchema,
        localClientDesktopCredentialSchema,
    ]),
});

export const localServerWelcomeSchema = protocolWelcomeSchema.extend({
    type: z.literal('welcome'),
    profileId: identifierSchema,
    processIdentity: hostProcessIdentitySchema,
    desktopLease: desktopLeaseSchema.optional(),
});

export const localClientCommandSchema = z.object({
    type: z.literal('command'),
    request: requestEnvelopeSchema,
});

export const localClientLeaseRenewSchema = z.object({
    type: z.literal('desktop-lease.renew'),
    generation: z.number().int().positive(),
});

export const localClientDesktopReadySchema = z.object({
    type: z.literal('desktop.ready'),
    generation: z.number().int().positive(),
});

export const localServerLeaseRenewedSchema = z.object({
    type: z.literal('desktop-lease.renewed'),
    lease: desktopLeaseSchema,
});

export const desktopLeaseRevocationReasonSchema = z.literal('replaced');
export type DesktopLeaseRevocationReason = z.infer<typeof desktopLeaseRevocationReasonSchema>;

/**
 * An orderly Host-side lease revocation lets a replaced Desktop distinguish intentional takeover from a recoverable
 * socket outage. The generation prevents a delayed control frame from revoking a newer attachment.
 */
export const localServerDesktopLeaseRevokedSchema = z.object({
    type: z.literal('desktop-lease.revoked'),
    generation: z.number().int().positive(),
    reason: desktopLeaseRevocationReasonSchema,
});

export const localServerReplySchema = z.object({
    type: z.literal('reply'),
    reply: commandReplyEnvelopeSchema,
});

export const localClientDesktopRuntimeCommandSchema = z.object({
    type: z.literal('desktop-runtime-command'),
    request: z.object({
        protocolVersion: protocolVersionSchema,
        id: identifierSchema,
        method: z.string().refine(isDesktopRuntimeMethod),
        params: z.unknown(),
    }),
});

export const localServerDesktopRuntimeReplySchema = z.object({
    type: z.literal('desktop-runtime-reply'),
    reply: commandReplyEnvelopeSchema,
});

const desktopFileTrashItemSchema = z.object({
    name: z.string().min(1).max(1_024),
    path: pathSchema,
    hasUnsavedChanges: z.boolean().optional(),
});
const desktopGitDiscardAllScopeSchema = z.object({
    kind: z.literal('all'),
    fileCount: z.number().int().positive().max(100_000),
});
const desktopGitDiscardFileScopeSchema = z.object({
    kind: z.literal('file'),
    path: pathSchema,
    untracked: z.boolean(),
});
const desktopGitDiscardTargetSchema = z.object({
    repositoryName: z.string().min(1).max(1_024),
    scope: z.discriminatedUnion('kind', [
        desktopGitDiscardAllScopeSchema,
        desktopGitDiscardFileScopeSchema,
    ]),
});

export const desktopOperationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('status') }),
    z.object({ kind: z.literal('focus') }),
    z.object({ kind: z.literal('open'), targetId: identifierSchema }),
    z.object({ kind: z.literal('reveal'), targetId: identifierSchema }),
    z.object({ kind: z.literal('openInEditor'), targetId: identifierSchema }),
    z.object({
        kind: z.literal('confirmFilesTrash'),
        item: desktopFileTrashItemSchema,
    }),
    z.object({ kind: z.literal('trash'), targetId: identifierSchema }),
    z.object({
        kind: z.literal('confirmGitDiscard'),
        target: desktopGitDiscardTargetSchema,
    }),
]);

export type DesktopOperation = z.infer<typeof desktopOperationSchema>;

export const localServerDesktopCommandSchema = z.object({
    type: z.literal('desktop-command'),
    lease: desktopLeaseSchema,
    request: z.object({
        protocolVersion: protocolVersionSchema,
        id: identifierSchema,
        operation: desktopOperationSchema,
    }),
});

export const localClientDesktopReplySchema = z.object({
    type: z.literal('desktop-reply'),
    generation: z.number().int().positive(),
    reply: commandReplyEnvelopeSchema,
});

export const localClientDesktopTargetConsumeSchema = z.object({
    type: z.literal('desktop-target.consume'),
    generation: z.number().int().positive(),
    id: identifierSchema,
    targetId: identifierSchema,
});

export const desktopTargetPayloadSchema = z.object({
    targetId: identifierSchema,
    operation: z.enum(['open', 'reveal', 'openInEditor', 'trash']),
    kind: z.enum(['file', 'directory']),
    sessionId: identifierSchema,
    path: pathSchema,
    location: z
        .object({
            line: z.number().int().positive(),
            column: z.number().int().positive(),
        })
        .optional(),
});

export type DesktopTargetPayload = z.infer<typeof desktopTargetPayloadSchema>;

export const localServerDesktopTargetReplySchema = z.object({
    type: z.literal('desktop-target.reply'),
    reply: commandReplyEnvelopeSchema,
});

export const localServerEventSchema = z.object({
    type: z.literal('event'),
    event: z.union([protocolEventEnvelopeSchema, transientRuntimeEventSchema]),
});

export type LocalClientHello = z.infer<typeof localClientHelloSchema>;
export type LocalServerWelcome = z.infer<typeof localServerWelcomeSchema>;
export type LocalClientCommand = z.infer<typeof localClientCommandSchema>;
export type LocalClientDesktopReply = z.infer<typeof localClientDesktopReplySchema>;
export type LocalClientDesktopRuntimeCommand = z.infer<
    typeof localClientDesktopRuntimeCommandSchema
>;
export type LocalClientDesktopTargetConsume = z.infer<typeof localClientDesktopTargetConsumeSchema>;
export type LocalClientDesktopReady = z.infer<typeof localClientDesktopReadySchema>;
export type LocalClientLeaseRenew = z.infer<typeof localClientLeaseRenewSchema>;
export type LocalServerReply = z.infer<typeof localServerReplySchema>;
export type LocalServerEvent = z.infer<typeof localServerEventSchema>;
export type LocalServerDesktopCommand = z.infer<typeof localServerDesktopCommandSchema>;
export type LocalServerDesktopLeaseRevoked = z.infer<typeof localServerDesktopLeaseRevokedSchema>;
export type LocalServerLeaseRenewed = z.infer<typeof localServerLeaseRenewedSchema>;
