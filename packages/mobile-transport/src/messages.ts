import { z } from 'zod';

import { mobileRevokedSchema } from './contract.js';

export const MOBILE_STREAM_CHUNK_MAX_BYTES = 24 * 1_024;

const identifierSchema = z.string().regex(/^[\w-]{1,200}$/u);
const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const heartbeatNonceSchema = z.string().regex(/^[0-9a-f]{32}$/u);

export const mobileSubscriptionResourceSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dashboard') }),
    z.strictObject({ kind: z.literal('terminal'), terminalId: identifierSchema }),
    z.strictObject({ kind: z.literal('conversation'), sessionId: identifierSchema }),
]);

export const mobileSubscribeResultSchema = z.strictObject({ subscriptionId: identifierSchema });
export const mobileUnsubscribeResultSchema = z.strictObject({});

export const mobileRequestPayloadSchema = z.strictObject({
    type: z.literal('request'),
    request: z.unknown(),
});
export const mobileSubscribePayloadSchema = z.strictObject({
    type: z.literal('subscribe'),
    id: identifierSchema,
    resource: mobileSubscriptionResourceSchema,
});
export const mobileUnsubscribePayloadSchema = z.strictObject({
    type: z.literal('unsubscribe'),
    id: identifierSchema,
    subscriptionId: identifierSchema,
});
export const mobileHeartbeatPayloadSchema = z.strictObject({
    type: z.literal('heartbeat'),
    nonce: heartbeatNonceSchema,
});

export const mobileClientPayloadSchema = z.discriminatedUnion('type', [
    mobileRequestPayloadSchema,
    mobileSubscribePayloadSchema,
    mobileUnsubscribePayloadSchema,
    mobileHeartbeatPayloadSchema,
]);

export const mobileReplyPayloadSchema = z.strictObject({
    type: z.literal('reply'),
    reply: z.unknown(),
});
export const mobileEventPayloadSchema = z.union([
    z.strictObject({
        type: z.literal('event'),
        subscriptionId: identifierSchema,
        sequence: sequenceSchema,
        kind: z.enum(['dashboard.changed', 'conversation.changed']),
    }),
    z.strictObject({
        type: z.literal('event'),
        subscriptionId: identifierSchema,
        sequence: sequenceSchema,
        kind: z.literal('resync-required'),
        reason: z.literal('capacity'),
    }),
]);
export const mobileStreamPayloadSchema = z.strictObject({
    type: z.literal('stream'),
    subscriptionId: identifierSchema,
    sequence: sequenceSchema,
    kind: z.literal('terminal.output'),
    chunkHex: z
        .string()
        .regex(/^(?:[0-9a-f]{2})+$/u)
        .max(MOBILE_STREAM_CHUNK_MAX_BYTES * 2),
});
export const mobileHeartbeatAckPayloadSchema = z.strictObject({
    type: z.literal('heartbeat-ack'),
    nonce: heartbeatNonceSchema,
});

export const mobileServerPayloadSchema = z.union([
    mobileReplyPayloadSchema,
    mobileEventPayloadSchema,
    mobileStreamPayloadSchema,
    mobileHeartbeatAckPayloadSchema,
    mobileRevokedSchema,
]);

export type MobileSubscriptionResource = z.infer<typeof mobileSubscriptionResourceSchema>;
export type MobileClientPayload = z.infer<typeof mobileClientPayloadSchema>;
export type MobileServerPayload = z.infer<typeof mobileServerPayloadSchema>;
export type MobileEventPayload = z.infer<typeof mobileEventPayloadSchema>;
export type MobileStreamPayload = z.infer<typeof mobileStreamPayloadSchema>;
