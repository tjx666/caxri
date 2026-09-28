import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

/**
 * Update recovery lets a paired phone whose transport version no longer matches Desktop fetch the Android update that
 * fixes the mismatch; see `docs/mobile/UPDATE.md`.
 *
 * This module is frozen: `update-recovery-v1` must keep working between a phone built today and every later Desktop,
 * across any number of `MOBILE_TRANSPORT_VERSION` bumps. It therefore imports nothing from the versioned transport
 * contract, and its schemas strip unknown keys instead of rejecting them. Extend it only additively; a breaking change
 * needs a new protocol identifier served beside this one, never an edit here.
 */
export const MOBILE_UPDATE_RECOVERY_PROTOCOL = 'update-recovery-v1' as const;

const RECOVERY_DOMAIN = utf8ToBytes('caxri-mobile-update-recovery-v1');
const RECOVERY_KEY_BYTES = 32;
const RECOVERY_CREDENTIAL_BYTES = 32;
export const MOBILE_UPDATE_RECOVERY_NONCE_BYTES = 32;
const RECOVERY_PROOF_BYTES = 32;
/**
 * The signed payload is a small JSON manifest plus one URL; the bound keeps a hostile peer from making the phone parse
 * an arbitrarily large string.
 */
const RECOVERY_PAYLOAD_MAX_LENGTH = 4_096;

const fixedHex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u'));
const identifierSchema = z.string().regex(/^[\w-]{1,200}$/u);
const protocolSchema = z.literal(MOBILE_UPDATE_RECOVERY_PROTOCOL);

/**
 * First frame of a recovery socket. It is sent instead of the versioned transport `hello`, so a Desktop recognizes it
 * whatever transport version the phone speaks.
 */
export const mobileUpdateRecoveryHelloSchema = z.object({
    type: z.literal('update-recovery-hello'),
    protocol: protocolSchema,
    deviceId: identifierSchema,
    generation: z.number().int().positive(),
    clientNonce: fixedHex(MOBILE_UPDATE_RECOVERY_NONCE_BYTES),
});

/**
 * Sent for every well-formed hello, so the challenge itself never discloses whether the device is paired.
 */
export const mobileUpdateRecoveryChallengeSchema = z.object({
    type: z.literal('update-recovery-challenge'),
    protocol: protocolSchema,
    serverNonce: fixedHex(MOBILE_UPDATE_RECOVERY_NONCE_BYTES),
});

export const mobileUpdateRecoveryProofSchema = z.object({
    type: z.literal('update-recovery-proof'),
    protocol: protocolSchema,
    proof: fixedHex(RECOVERY_PROOF_BYTES),
});

/**
 * `payload` is the exact JSON text the Server authenticated, so both sides MAC the same bytes without a canonical JSON
 * encoding. Parse it with {@link mobileUpdateRecoveryPayloadSchema} only after the proof verifies.
 */
export const mobileUpdateRecoveryResultSchema = z.object({
    type: z.literal('update-recovery-result'),
    protocol: protocolSchema,
    payload: z.string().min(2).max(RECOVERY_PAYLOAD_MAX_LENGTH),
    proof: fixedHex(RECOVERY_PROOF_BYTES),
});

/**
 * One indistinguishable answer for an unpaired, revoked, stale, or wrongly proven device.
 */
export const mobileUpdateRecoveryRejectedSchema = z.object({
    type: z.literal('update-recovery-rejected'),
    protocol: protocolSchema,
});

const recoveryBundleSchema = z.object({
    version: z
        .string()
        .regex(/^\d{1,4}\.\d{1,3}\.\d{1,3}$/u)
        .max(16),
    versionCode: z.number().int().positive().max(2_100_000_000),
    sizeBytes: z
        .number()
        .int()
        .positive()
        .max(512 * 1_024 * 1_024),
    md5: z.string().regex(/^[0-9a-f]{32}$/u),
});

/**
 * Either the bundled APK manifest with a short-lived download URL on the gateway endpoint, or no bundle at all.
 */
export const mobileUpdateRecoveryPayloadSchema = z.union([
    z.object({
        bundle: recoveryBundleSchema,
        url: z.url({ protocol: /^http$/u }).max(2_048),
        expiresAt: z.number().int().positive(),
    }),
    z.object({ bundle: z.null() }),
]);

export type MobileUpdateRecoveryHello = z.infer<typeof mobileUpdateRecoveryHelloSchema>;
export type MobileUpdateRecoveryPayload = z.infer<typeof mobileUpdateRecoveryPayloadSchema>;

/**
 * Everything both peers must agree on. `serverId` comes from the phone's stored pairing and from the Server's own
 * identity, so a proof made for one Desktop profile never verifies on another.
 */
export interface MobileUpdateRecoveryTranscript {
    clientNonce: Uint8Array;
    deviceId: string;
    generation: number;
    serverId: string;
    serverNonce: Uint8Array;
}

const lengthPrefixed = (value: Uint8Array): Uint8Array => {
    if (value.length > 65_535) throw new Error('Recovery transcript field is too long');
    return concatBytes(new Uint8Array([value.length >> 8, value.length & 0xff]), value);
};

const transcriptHash = (transcript: MobileUpdateRecoveryTranscript): Uint8Array => {
    if (
        transcript.clientNonce.length !== MOBILE_UPDATE_RECOVERY_NONCE_BYTES ||
        transcript.serverNonce.length !== MOBILE_UPDATE_RECOVERY_NONCE_BYTES
    )
        throw new Error('Recovery nonce length is invalid');
    if (!Number.isSafeInteger(transcript.generation) || transcript.generation < 1)
        throw new Error('Recovery generation is invalid');
    const fields = [
        utf8ToBytes(transcript.serverId),
        utf8ToBytes(transcript.deviceId),
        utf8ToBytes(String(transcript.generation)),
        transcript.clientNonce,
        transcript.serverNonce,
    ];
    const bytes = concatBytes(RECOVERY_DOMAIN, ...fields.map(lengthPrefixed));
    return sha256(bytes);
};

/**
 * Binds the pairing credential to one exchange. Both nonces enter the salt, so a captured proof never verifies against
 * a later challenge, and the credential itself never keys a MAC directly.
 */
export const deriveMobileUpdateRecoveryKey = (input: {
    credential: Uint8Array;
    transcript: MobileUpdateRecoveryTranscript;
}): Uint8Array => {
    if (input.credential.length !== RECOVERY_CREDENTIAL_BYTES)
        throw new Error('Recovery credential length is invalid');
    return hkdf(
        sha256,
        input.credential,
        transcriptHash(input.transcript),
        RECOVERY_DOMAIN,
        RECOVERY_KEY_BYTES,
    );
};

export const mobileUpdateRecoveryClientProof = (key: Uint8Array): Uint8Array =>
    hmac(sha256, key, concatBytes(RECOVERY_DOMAIN, utf8ToBytes('proof:client')));

/**
 * Authenticates the exact payload text, so a peer without the credential cannot substitute the download URL or MD5.
 */
export const mobileUpdateRecoveryServerProof = (key: Uint8Array, payload: string): Uint8Array =>
    hmac(
        sha256,
        key,
        concatBytes(RECOVERY_DOMAIN, utf8ToBytes('proof:server'), utf8ToBytes(payload)),
    );

/**
 * Compares authentication tags without returning on the first mismatched byte.
 */
export const isMobileUpdateRecoveryProofEqual = (
    actual: Uint8Array,
    expected: Uint8Array,
): boolean => {
    if (actual.length !== RECOVERY_PROOF_BYTES || expected.length !== RECOVERY_PROOF_BYTES)
        return false;
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1)
        difference |= actual[index]! ^ expected[index]!;
    return difference === 0;
};
