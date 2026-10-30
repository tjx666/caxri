import { z } from 'zod';

import { relayHostIdSchema, relayUrlSchema } from './relay.js';

export const MOBILE_TRANSPORT_VERSION = 4 as const;
export const MOBILE_GATEWAY_MAX_FRAME_BYTES = 64 * 1024;
export const MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES = MOBILE_GATEWAY_MAX_FRAME_BYTES - 16;
export const MOBILE_GATEWAY_MAX_WIRE_BYTES = MOBILE_GATEWAY_MAX_FRAME_BYTES * 2 + 2_048;
export const PAIRING_SECRET_BYTES = 32;
export const SESSION_KEY_BYTES = 32;
export const HANDSHAKE_NONCE_BYTES = 32;
export const X25519_KEY_BYTES = 32;
export const MOBILE_MAX_FRAME_COUNTER = 2 ** 48 - 1;

const fixedHex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u'));
const identifierSchema = z.string().regex(/^[\w-]{1,200}$/u);

/**
 * Mobile endpoints accept private LAN, Tailscale IPv4, and the exact test-only loopback endpoint.
 */
export const isPrivateMobileIpv4Address = (address: string): boolean => {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4) return false;
    if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 255)) return false;
    const [first, second] = parts as [number, number, number, number];
    return (
        address === '127.0.0.1' ||
        first === 10 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
    );
};

const privateIpv4AddressSchema = z
    .ipv4()
    .refine(isPrivateMobileIpv4Address, 'Mobile endpoints must use a supported private network');
const hasUnsafeDeviceNameCharacter = (value: string): boolean =>
    [...value].some((character) => {
        const code = character.codePointAt(0)!;
        return (
            code < 32 ||
            (code >= 127 && code <= 159) ||
            (code >= 0x20_2a && code <= 0x20_2e) ||
            (code >= 0x20_66 && code <= 0x20_69)
        );
    });
const mobileDeviceDisplayNameSchema = z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(
        (value) => !hasUnsafeDeviceNameCharacter(value),
        'Mobile device names cannot contain control characters',
    );

export const mobilePairingLinkSchema = z.strictObject({
    version: z.literal(MOBILE_TRANSPORT_VERSION),
    addresses: z
        .array(privateIpv4AddressSchema)
        .min(1)
        .max(8)
        .refine((addresses) => new Set(addresses).size === addresses.length),
    port: z.number().int().min(1).max(65_535),
    serverId: identifierSchema,
    pairingId: fixedHex(16),
    secret: fixedHex(PAIRING_SECRET_BYTES),
    expiresAt: z.number().int().positive(),
    /**
     * Present when the Server is registered with a Relay; the phone falls back to it when no LAN address answers.
     */
    relay: z
        .strictObject({
            url: relayUrlSchema,
            hostId: relayHostIdSchema,
        })
        .optional(),
});

/**
 * How the phone reached this socket, reported in its reconnect hello so the Server log can explain a slow reconnect end
 * to end. Timing only: no address, URL, or network name.
 */
export const mobileConnectTraceSchema = z.strictObject({
    /**
     * How long direct routes raced alone before the Relay could join.
     */
    graceMs: z.number().int().min(0).max(60_000),
    /**
     * From starting the route race until this socket was open (for the Relay, until `relay-ready`).
     */
    openMs: z.number().int().min(0).max(120_000),
});

export type MobileConnectTrace = z.infer<typeof mobileConnectTraceSchema>;

export const mobileClientHelloSchema = z.discriminatedUnion('mode', [
    z.strictObject({
        type: z.literal('hello'),
        version: z.literal(MOBILE_TRANSPORT_VERSION),
        mode: z.literal('pair'),
        pairingId: fixedHex(16),
        displayName: mobileDeviceDisplayNameSchema,
        platform: z.enum(['android', 'ios']),
        clientPublicKey: fixedHex(X25519_KEY_BYTES),
        clientNonce: fixedHex(HANDSHAKE_NONCE_BYTES),
    }),
    z.strictObject({
        type: z.literal('hello'),
        version: z.literal(MOBILE_TRANSPORT_VERSION),
        mode: z.literal('connect'),
        deviceId: identifierSchema,
        generation: z.number().int().positive(),
        clientPublicKey: fixedHex(X25519_KEY_BYTES),
        clientNonce: fixedHex(HANDSHAKE_NONCE_BYTES),
        trace: mobileConnectTraceSchema.optional(),
    }),
]);

export const mobileServerHelloSchema = z.strictObject({
    type: z.literal('challenge'),
    version: z.literal(MOBILE_TRANSPORT_VERSION),
    connectionId: fixedHex(16),
    deviceId: identifierSchema,
    generation: z.number().int().positive(),
    serverPublicKey: fixedHex(X25519_KEY_BYTES),
    serverNonce: fixedHex(HANDSHAKE_NONCE_BYTES),
    confirmation: fixedHex(32),
});

/**
 * A version gate before authentication cannot disclose pairing or device state.
 */
export const mobileVersionMismatchSchema = z.strictObject({
    type: z.literal('version-mismatch'),
    supportedVersion: z.number().int().positive().max(255),
});

export const mobileClientConfirmationSchema = z.strictObject({
    type: z.literal('confirm'),
    version: z.literal(MOBILE_TRANSPORT_VERSION),
    connectionId: fixedHex(16),
    confirmation: fixedHex(32),
});

export const mobileSealedFrameSchema = z.strictObject({
    type: z.literal('sealed'),
    version: z.literal(MOBILE_TRANSPORT_VERSION),
    connectionId: fixedHex(16),
    counter: z.number().int().min(0).max(MOBILE_MAX_FRAME_COUNTER),
    ciphertext: z.string().regex(/^[0-9a-f]{32,131072}$/u),
});

export const mobilePairingResultSchema = z.strictObject({
    type: z.literal('paired'),
    deviceId: identifierSchema,
    generation: z.number().int().positive(),
    credential: fixedHex(PAIRING_SECRET_BYTES),
    projectIds: z.array(identifierSchema).min(1).max(128),
});

export const mobileRevokedSchema = z.strictObject({
    type: z.literal('revoked'),
    deviceId: identifierSchema,
    generation: z.number().int().positive(),
});

export type MobilePairingLink = z.infer<typeof mobilePairingLinkSchema>;
export type MobileClientHello = z.infer<typeof mobileClientHelloSchema>;
export type MobileServerHello = z.infer<typeof mobileServerHelloSchema>;
export type MobileVersionMismatch = z.infer<typeof mobileVersionMismatchSchema>;
export type MobileClientConfirmation = z.infer<typeof mobileClientConfirmationSchema>;
export type MobileSealedFrame = z.infer<typeof mobileSealedFrameSchema>;
export type MobilePairingResult = z.infer<typeof mobilePairingResultSchema>;
