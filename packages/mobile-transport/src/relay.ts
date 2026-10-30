/**
 * Wire contract for the Caxri Relay: a separately deployed rendezvous service that splices a phone's WebSocket to the
 * Server's outbound connection. The Relay never terminates the mobile handshake; every byte after `relay-ready` is the
 * unchanged end-to-end encrypted gateway stream, so the Relay sees routing identifiers, sizes, and timing only.
 *
 * Three sockets take part in one relayed connection:
 *
 * 1. Host control (`/v1/host`): the Server dials out, answers `relay-challenge` with an Ed25519 proof over its host key,
 *    and keeps the access-key grants in sync. The Relay derives the host ID from that key, so registration cannot be
 *    claimed by anyone without the private key.
 * 2. Client (`/v1/client`): the phone sends `relay-connect` with the host ID and an access key; the Relay checks the key's
 *    hash against the host's grants before the Server learns about the attempt.
 * 3. Host data (`/v1/host-data`): on `relay-incoming`, the Server dials back with the one-use ticket; the Relay splices it
 *    to the waiting client and sends `relay-ready` to the phone.
 *
 * A Server that registers with `standby` also keeps one idle host-data socket parked at the Relay, authenticated by the
 * registration's `relay-standby` ticket. A phone that arrives while one is parked is spliced to it at once (the Server
 * learns from `relay-spliced`), so the common case skips the dial-back's TCP and TLS setup. Frames the phone sends
 * after `relay-connect` but before the splice are held by the Relay and forwarded in order.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

import { decodeHex, encodeHex } from './encoding.js';

export const RELAY_PROTOCOL_VERSION = 1 as const;
const RELAY_HOST_ID_BYTES = 16;
const RELAY_HOST_KEY_BYTES = 32;
const RELAY_SIGNATURE_BYTES = 64;
const RELAY_ACCESS_KEY_BYTES = 32;
export const RELAY_CHALLENGE_BYTES = 32;
export const RELAY_TICKET_BYTES = 32;
export const RELAY_CONNECTION_ID_BYTES = 16;
/**
 * Upper bound of live grants per host: paired devices plus pending pairings, far above the gateway's own limits.
 */
export const RELAY_MAX_GRANTS = 256;
const RELAY_URL_MAX_LENGTH = 512;
/**
 * Size of the shared secrets an access key derives from; equals the gateway's pairing secret and device credential.
 */
const RELAY_ACCESS_SECRET_BYTES = 32;

/**
 * Paths appended to the configured Relay base URL. A base URL may carry a path prefix for reverse proxies.
 */
export const relayPaths = {
    client: '/v1/client',
    host: '/v1/host',
    hostData: '/v1/host-data',
    health: '/health',
} as const;

const DOMAIN = `caxri-relay-v${RELAY_PROTOCOL_VERSION}`;
const fixedHex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u'));

/**
 * `wss:` for any host, `ws:` too because a self-hosted Relay may sit behind a TLS-terminating proxy on a private
 * network or run in local Docker; the gateway stream inside stays end-to-end encrypted either way.
 */
export const isRelayUrl = (value: string): boolean => {
    if (value.length > RELAY_URL_MAX_LENGTH) return false;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return (
        (url.protocol === 'wss:' || url.protocol === 'ws:') &&
        url.hostname.length > 0 &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
    );
};

export const relayUrlSchema = z.string().refine(isRelayUrl, 'Expected a ws:// or wss:// Relay URL');
export const relayHostIdSchema = fixedHex(RELAY_HOST_ID_BYTES);
const relayAccessKeyHashSchema = fixedHex(32);

/**
 * Joins a Relay base URL and one of `relayPaths`, keeping any base path prefix.
 */
export const relayEndpoint = (
    baseUrl: string,
    path: (typeof relayPaths)[keyof typeof relayPaths],
): string => {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`;
    return url.href;
};

export const relayHostIdForPublicKey = (publicKey: Uint8Array): string => {
    if (publicKey.length !== RELAY_HOST_KEY_BYTES)
        throw new Error('Relay host key length is invalid');
    const digest = sha256(concatBytes(utf8ToBytes(`${DOMAIN}:host-id`), publicKey));
    return encodeHex(digest.slice(0, RELAY_HOST_ID_BYTES));
};

export const createRelayHostKey = (): { publicKey: Uint8Array; secretKey: Uint8Array } => {
    const secretKey = ed25519.utils.randomSecretKey();
    return { publicKey: ed25519.getPublicKey(secretKey), secretKey };
};

export const relayHostPublicKey = (secretKey: Uint8Array): Uint8Array => {
    if (secretKey.length !== RELAY_HOST_KEY_BYTES)
        throw new Error('Relay host key length is invalid');
    return ed25519.getPublicKey(secretKey);
};

const hostProofMessage = (challenge: Uint8Array): Uint8Array => {
    if (challenge.length !== RELAY_CHALLENGE_BYTES)
        throw new Error('Relay challenge length is invalid');
    return concatBytes(utf8ToBytes(`${DOMAIN}:host-proof`), challenge);
};

export const signRelayHostChallenge = (secretKey: Uint8Array, challenge: Uint8Array): Uint8Array =>
    ed25519.sign(hostProofMessage(challenge), secretKey);

export const isRelayHostProofValid = (input: {
    challenge: Uint8Array;
    publicKey: Uint8Array;
    signature: Uint8Array;
}): boolean => {
    if (
        input.publicKey.length !== RELAY_HOST_KEY_BYTES ||
        input.signature.length !== RELAY_SIGNATURE_BYTES
    )
        return false;
    try {
        return ed25519.verify(input.signature, hostProofMessage(input.challenge), input.publicKey);
    } catch {
        return false;
    }
};

/**
 * Access keys are one-way derivations of secrets the phone and Server already share: the paired device credential, or
 * the pairing secret while a QR link is pending. The Relay only ever stores `relayAccessKeyHash`, so neither it nor a
 * leaked grant list can recover the gateway's preshared key.
 */
export const relayAccessKey = (secret: Uint8Array, purpose: 'device' | 'pairing'): Uint8Array => {
    if (secret.length !== RELAY_ACCESS_SECRET_BYTES)
        throw new Error('Relay access secret length is invalid');
    return hkdf(
        sha256,
        secret,
        undefined,
        utf8ToBytes(`${DOMAIN}:access:${purpose}`),
        RELAY_ACCESS_KEY_BYTES,
    );
};

export const relayAccessKeyHash = (accessKey: Uint8Array): string => {
    if (accessKey.length !== RELAY_ACCESS_KEY_BYTES)
        throw new Error('Relay access key length is invalid');
    const digest = sha256(concatBytes(utf8ToBytes(`${DOMAIN}:access-hash`), accessKey));
    return encodeHex(digest);
};

export const relayAccessKeyHashFromHex = (accessKeyHex: string): string =>
    relayAccessKeyHash(decodeHex(accessKeyHex, RELAY_ACCESS_KEY_BYTES));

const relayGrantSchema = z.strictObject({
    keyHash: relayAccessKeyHashSchema,
    /**
     * Pending pairings expire with their QR link; device grants stay until removed.
     */
    expiresAt: z.number().int().positive().optional(),
});

export const relayClientConnectSchema = z.strictObject({
    type: z.literal('relay-connect'),
    version: z.literal(RELAY_PROTOCOL_VERSION),
    hostId: relayHostIdSchema,
    accessKey: fixedHex(RELAY_ACCESS_KEY_BYTES),
});

export const relayClientReadySchema = z.strictObject({
    type: z.literal('relay-ready'),
    version: z.literal(RELAY_PROTOCOL_VERSION),
});

export const relayChallengeSchema = z.strictObject({
    type: z.literal('relay-challenge'),
    version: z.literal(RELAY_PROTOCOL_VERSION),
    nonce: fixedHex(RELAY_CHALLENGE_BYTES),
});

export const relayHostRegisterSchema = z.strictObject({
    type: z.literal('host-register'),
    version: z.literal(RELAY_PROTOCOL_VERSION),
    publicKey: fixedHex(RELAY_HOST_KEY_BYTES),
    signature: fixedHex(RELAY_SIGNATURE_BYTES),
    grants: z.array(relayGrantSchema).max(RELAY_MAX_GRANTS),
    /**
     * Asks for a `relay-standby` ticket so the Server can park an idle host-data socket. Opt-in, because a Server that
     * does not understand `relay-standby` would treat it as a protocol error.
     */
    standby: z.literal(true).optional(),
});

export const relayHostRegisteredSchema = z.strictObject({
    type: z.literal('host-registered'),
    version: z.literal(RELAY_PROTOCOL_VERSION),
    hostId: relayHostIdSchema,
});

export const relayGrantUpdateSchema = z.strictObject({
    type: z.literal('grant-update'),
    add: z.array(relayGrantSchema).max(RELAY_MAX_GRANTS),
    remove: z.array(relayAccessKeyHashSchema).max(RELAY_MAX_GRANTS),
});

export const relayIncomingSchema = z.strictObject({
    type: z.literal('relay-incoming'),
    connectionId: fixedHex(RELAY_CONNECTION_ID_BYTES),
    ticket: fixedHex(RELAY_TICKET_BYTES),
});

export const relayHostAcceptSchema = z.strictObject({
    type: z.literal('host-accept'),
    version: z.literal(RELAY_PROTOCOL_VERSION),
    hostId: relayHostIdSchema,
    connectionId: fixedHex(RELAY_CONNECTION_ID_BYTES),
    ticket: fixedHex(RELAY_TICKET_BYTES),
});

/**
 * Sent on the control socket after `host-registered` to a host that asked for `standby`. The ticket stays valid for
 * this registration and admits one parked host-data socket at a time.
 */
export const relayStandbySchema = z.strictObject({
    type: z.literal('relay-standby'),
    ticket: fixedHex(RELAY_TICKET_BYTES),
});

/**
 * Every control frame the Relay sends after `host-registered`.
 */
export const relayHostControlSchema = z.discriminatedUnion('type', [
    relayIncomingSchema,
    relayStandbySchema,
]);

/**
 * The first frame of a parked host-data socket.
 */
export const relayHostStandbySchema = z.strictObject({
    type: z.literal('host-standby'),
    version: z.literal(RELAY_PROTOCOL_VERSION),
    hostId: relayHostIdSchema,
    ticket: fixedHex(RELAY_TICKET_BYTES),
});

export const relayHostDataFirstFrameSchema = z.discriminatedUnion('type', [
    relayHostAcceptSchema,
    relayHostStandbySchema,
]);

/**
 * Tells a parked host-data socket that a phone was spliced to it; every later frame is the phone's gateway stream.
 */
export const relayStandbySplicedSchema = z.strictObject({
    type: z.literal('relay-spliced'),
    version: z.literal(RELAY_PROTOCOL_VERSION),
});

export type RelayGrant = z.infer<typeof relayGrantSchema>;
export type RelayHostAccept = z.infer<typeof relayHostAcceptSchema>;
export type RelayHostStandby = z.infer<typeof relayHostStandbySchema>;

/**
 * Relay decisions carried as private-range close codes (4400-4599, distinct from the phone's 4001-4099 reasons). The
 * Relay also mirrors an application close code across a splice, so the Server still records the phone's own reason.
 */
export const relayCloseCodes = {
    /**
     * A first frame was missing, malformed, or for an unsupported protocol version.
     */
    'invalid-request': 4400,
    /**
     * The host proof or client access key did not verify.
     */
    'unauthorized': 4401,
    /**
     * No host with that ID is registered right now.
     */
    'host-offline': 4404,
    /**
     * The host did not dial back for a client in time.
     */
    'host-timeout': 4408,
    /**
     * A newer verified registration for the same host replaced this control socket.
     */
    'replaced': 4409,
    /**
     * The spliced peer went away without a close frame of its own.
     */
    'peer-gone': 4410,
    /**
     * The source exceeded the Relay's attempt budget.
     */
    'rate-limited': 4429,
    /**
     * The Relay or this host reached a connection or buffer limit.
     */
    'capacity': 4503,
    /**
     * The Relay is restarting; reconnect after backoff.
     */
    'shutting-down': 4504,
} as const;

export type RelayCloseReason = keyof typeof relayCloseCodes;

const relayReasonByCode = new Map<number, RelayCloseReason>(
    Object.entries(relayCloseCodes).map(([reason, code]) => [code, reason as RelayCloseReason]),
);

export const relayCloseReasonOf = (code: number): RelayCloseReason | undefined =>
    relayReasonByCode.get(code);
