import { z } from 'zod';

import { isDesktopRuntimeMethod } from '../desktop/desktop-runtime.js';
import { identifierSchema, pathSchema } from '../domain/domain.js';
import { protocolEventEnvelopeSchema, transientRuntimeEventSchema } from './event-journal.js';
import { commandReplyEnvelopeSchema, requestEnvelopeSchema } from './transport.js';
import { protocolHelloSchema, protocolVersionSchema, protocolWelcomeSchema } from './version.js';

export const HOST_MANIFEST_VERSION = 1 as const;
export const HOST_DESKTOP_CREDENTIAL_VERSION = 1 as const;
/**
 * One authenticated JSON-line frame can contain two 16 MiB editor buffers. The extra headroom
 * covers worst-case JSON escaping while keeping a malformed local peer under a fixed memory cap.
 */
export const LOCAL_TRANSPORT_MAX_FRAME_BYTES = 256 * 1024 * 1024;
export const hostCredentialTokenSchema = z.string().regex(/^[0-9a-f]{64}$/u);
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
    operatorToken: hostCredentialTokenSchema,
});

export type HostManifest = z.infer<typeof hostManifestSchema>;

export const hostLockSchema = hostManifestSchema.pick({
    pid: true,
    startedAt: true,
    processIdentity: true,
    profileId: true,
});

export type HostLock = z.infer<typeof hostLockSchema>;

/** Separate Desktop credential. It is never exposed through the operator discovery manifest. */
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

/** Incrementally decodes bounded JSON lines without repeatedly copying an incomplete frame. */
export class LocalJsonLineDecoder {
    private readonly encoder = new TextEncoder();
    private readonly parts: string[] = [];
    private pendingBytes = 0;

    constructor(private readonly maximumFrameBytes = LOCAL_TRANSPORT_MAX_FRAME_BYTES) {}

    push(chunk: string): string[] {
        const lines: string[] = [];
        let offset = 0;
        let newline = chunk.indexOf('\n', offset);
        while (newline !== -1) {
            const part = chunk.slice(offset, newline);
            this.append(part);
            lines.push(this.parts.join(''));
            this.parts.length = 0;
            this.pendingBytes = 0;
            offset = newline + 1;
            newline = chunk.indexOf('\n', offset);
        }
        if (offset < chunk.length) this.append(chunk.slice(offset));
        return lines;
    }

    private append(part: string): void {
        this.pendingBytes += this.encoder.encode(part).byteLength;
        if (this.pendingBytes > this.maximumFrameBytes)
            throw new RangeError(`Local transport frame exceeds ${this.maximumFrameBytes} bytes`);
        if (part.length > 0) this.parts.push(part);
    }
}

export const localClientHelloSchema = protocolHelloSchema.extend({
    type: z.literal('hello'),
    profileId: identifierSchema,
    credential: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('operator'), token: hostCredentialTokenSchema }),
        z.object({
            kind: z.literal('agent'),
            hostId: hostProcessIdentitySchema,
            endpointId: identifierSchema,
            generation: z.number().int().positive(),
            token: hostCredentialTokenSchema,
        }),
        z.object({
            kind: z.literal('desktop'),
            token: hostCredentialTokenSchema,
            desktopId: identifierSchema,
        }),
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

export const desktopOperationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('status') }),
    z.object({ kind: z.literal('focus') }),
    z.object({ kind: z.literal('open'), targetId: identifierSchema }),
    z.object({ kind: z.literal('reveal'), targetId: identifierSchema }),
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
    operation: z.enum(['open', 'reveal']),
    kind: z.enum(['file', 'directory']),
    sessionId: identifierSchema,
    path: pathSchema,
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
export type LocalServerLeaseRenewed = z.infer<typeof localServerLeaseRenewedSchema>;
