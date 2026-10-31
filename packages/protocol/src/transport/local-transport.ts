import { z } from 'zod';

import { isDesktopServerOperation } from '../desktop/desktop-server-operations.js';
import { editorNavigationTargetSchema } from '../domain/editor.js';
import { identifierSchema, pathSchema } from '../domain/identifiers.js';
import { protocolEventEnvelopeSchema, transientServerEventSchema } from './event-journal.js';
import {
    protocolClientIdentitySchema,
    serverCredentialTokenSchema,
    serverProcessIdentitySchema,
} from './identity.js';
import { commandReplyEnvelopeSchema, requestEnvelopeSchema } from './transport.js';
import { protocolHelloSchema, protocolVersionSchema, protocolWelcomeSchema } from './version.js';

export const SERVER_MANIFEST_VERSION = 2 as const;
export const SERVER_DESKTOP_CREDENTIAL_VERSION = 1 as const;
/**
 * One authenticated control message can contain two 16 MiB editor buffers. The extra headroom covers worst-case JSON
 * escaping while keeping a malformed peer under a fixed memory cap.
 */
export const CONTROL_TRANSPORT_MAX_FRAME_BYTES = 256 * 1024 * 1024;

export const serverControlEndpointSchema = z.object({
    protocol: z.literal('ws'),
    host: z.literal('127.0.0.1'),
    port: z.number().int().positive().max(65_535),
    path: z.literal('/control'),
});

export type ServerControlEndpoint = z.infer<typeof serverControlEndpointSchema>;

export function serverEndpointUrl(endpoint: ServerControlEndpoint): string {
    return `ws://${endpoint.host}:${endpoint.port}${endpoint.path}`;
}

const serverManifestIdentitySchema = z.object({
    profileId: identifierSchema,
    pid: z.number().int().positive(),
    startedAt: z.number().int().positive(),
    processIdentity: serverProcessIdentitySchema,
    /**
     * Kept open so an incompatible client can report a clean error instead of treating the discovery record as corrupt.
     */
    protocolVersion: z.number().int().positive(),
    version: z.string().min(1).max(100),
    operatorToken: serverCredentialTokenSchema,
});

export type ServerManifestIdentity = z.infer<typeof serverManifestIdentitySchema>;

/**
 * Private profile discovery record. The credential must never appear in status or diagnostics.
 */
export const serverManifestSchema = serverManifestIdentitySchema.extend({
    manifestVersion: z.literal(SERVER_MANIFEST_VERSION),
    endpoint: serverControlEndpointSchema,
});

export type ServerManifest = z.infer<typeof serverManifestSchema>;

export const serverLockSchema = serverManifestIdentitySchema.pick({
    pid: true,
    startedAt: true,
    processIdentity: true,
    profileId: true,
});

export type ServerLock = z.infer<typeof serverLockSchema>;

/**
 * Separate Desktop credential. It is never exposed through the operator discovery manifest.
 */
export const serverDesktopCredentialSchema = z.object({
    credentialVersion: z.literal(SERVER_DESKTOP_CREDENTIAL_VERSION),
    profileId: identifierSchema,
    processIdentity: serverProcessIdentitySchema,
    desktopToken: serverCredentialTokenSchema,
});

export type ServerDesktopCredential = z.infer<typeof serverDesktopCredentialSchema>;

const desktopLeaseSchema = z.object({
    desktopId: identifierSchema,
    generation: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
});

export type DesktopLease = z.infer<typeof desktopLeaseSchema>;

const localClientOperatorCredentialSchema = z.object({
    kind: z.literal('operator'),
    token: serverCredentialTokenSchema,
});

const localClientAgentCredentialSchema = z.object({
    kind: z.literal('agent'),
    hostId: serverProcessIdentitySchema,
    endpointId: identifierSchema,
    generation: z.number().int().positive(),
    token: serverCredentialTokenSchema,
});

const localClientDesktopCredentialSchema = z.object({
    kind: z.literal('desktop'),
    token: serverCredentialTokenSchema,
    desktopId: identifierSchema,
});

const localClientDelegationCredentialSchema = z.object({
    kind: z.literal('delegation-client'),
    clientId: z.uuid(),
    generation: z.number().int().positive(),
    token: serverCredentialTokenSchema,
});

export const localClientHelloSchema = protocolHelloSchema.extend({
    type: z.literal('hello'),
    profileId: identifierSchema,
    clientId: protocolClientIdentitySchema,
    credential: z.discriminatedUnion('kind', [
        localClientOperatorCredentialSchema,
        localClientAgentCredentialSchema,
        localClientDelegationCredentialSchema,
        localClientDesktopCredentialSchema,
    ]),
});

export const localServerWelcomeSchema = protocolWelcomeSchema.extend({
    type: z.literal('welcome'),
    profileId: identifierSchema,
    processIdentity: serverProcessIdentitySchema,
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

const desktopLeaseRevocationReasonSchema = z.literal('replaced');
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

export const localClientDesktopOperationCommandSchema = z.object({
    type: z.literal('desktop-runtime-command'),
    request: z.object({
        protocolVersion: protocolVersionSchema,
        id: identifierSchema,
        method: z.string().refine(isDesktopServerOperation),
        params: z.unknown(),
    }),
});

export const localServerDesktopOperationReplySchema = z.object({
    type: z.literal('desktop-runtime-reply'),
    reply: commandReplyEnvelopeSchema,
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

/**
 * Native operations Server Core may ask Desktop Main to perform. Trash is deliberately absent: `files.trash` is a
 * Desktop-owned method that Main handles end to end (prompt, reauthorization, `shell.trashItem`), so a second
 * Server-routed Trash flow would only duplicate that authorization contract.
 */
export const desktopOperationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('status') }),
    z.object({ kind: z.literal('focus') }),
    z.object({ kind: z.literal('open'), targetId: identifierSchema }),
    z.object({ kind: z.literal('reveal'), targetId: identifierSchema }),
    z.object({ kind: z.literal('openWithDefaultApp'), targetId: identifierSchema }),
    /**
     * Carries the resolved `workbench.externalEditor` command with the operation instead of letting Main read it back
     * from Server Core. A Desktop command handler may only call back over the dedicated `desktop-target.consume` lane;
     * any ordinary request it issues lands in the per-connection ordered queue that the very command it is servicing is
     * still blocking, which deadlocks both sides until the 15s Desktop command timeout fires.
     */
    z.object({
        kind: z.literal('openInEditor'),
        targetId: identifierSchema,
        editorCommand: z.string().min(1).max(1_024).optional(),
    }),
    z.object({
        kind: z.literal('confirmGitDiscard'),
        target: desktopGitDiscardTargetSchema,
    }),
    /**
     * Drives Main's app update for a paired phone (`mobile.desktopUpdate.*`). `read` answers the current state; `check`
     * and `download` start that step and answer at once, since a download outlives the 15s Desktop command timeout;
     * `install` restarts into the staged `version` without the computer's confirmation prompts, which the phone already
     * showed, and answers before Main starts quitting.
     */
    z.object({
        kind: z.literal('update'),
        action: z.enum(['read', 'check', 'download', 'install']),
        version: z.string().min(1).max(64).optional(),
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

const sessionDesktopTargetPayloadSchema = z.object({
    targetId: identifierSchema,
    operation: z.enum(['open', 'reveal', 'openWithDefaultApp', 'openInEditor']),
    kind: z.enum(['file', 'directory']),
    sessionId: identifierSchema,
    path: pathSchema,
    location: editorNavigationTargetSchema.optional(),
    focusEditor: z.boolean().optional(),
});

export const desktopTargetPayloadSchema = z.union([
    sessionDesktopTargetPayloadSchema,
    sessionDesktopTargetPayloadSchema.omit({ sessionId: true }).extend({
        operation: z.enum(['reveal', 'openInEditor']),
        kind: z.literal('directory'),
        projectId: identifierSchema,
        sessionId: z.undefined().optional(),
    }),
]);

export type DesktopTargetPayload = z.infer<typeof desktopTargetPayloadSchema>;

export const localServerDesktopTargetReplySchema = z.object({
    type: z.literal('desktop-target.reply'),
    reply: commandReplyEnvelopeSchema,
});

export const localServerEventSchema = z.object({
    type: z.literal('event'),
    event: z.union([protocolEventEnvelopeSchema, transientServerEventSchema]),
});
export type LocalClientCommand = z.infer<typeof localClientCommandSchema>;
export type LocalServerReply = z.infer<typeof localServerReplySchema>;
export type LocalServerEvent = z.infer<typeof localServerEventSchema>;
export type LocalServerDesktopCommand = z.infer<typeof localServerDesktopCommandSchema>;
