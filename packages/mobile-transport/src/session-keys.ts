import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import {
    HANDSHAKE_NONCE_BYTES,
    MOBILE_MAX_FRAME_COUNTER,
    MOBILE_TRANSPORT_VERSION,
    PAIRING_SECRET_BYTES,
    SESSION_KEY_BYTES,
    X25519_KEY_BYTES,
} from './contract.js';

const DOMAIN = utf8ToBytes(`caxri-mobile-transport-v${MOBILE_TRANSPORT_VERSION}`);
const SESSION_MATERIAL_BYTES = 3 * SESSION_KEY_BYTES;

export interface HandshakeTranscript {
    clientNonce: Uint8Array;
    clientPublicKey: Uint8Array;
    connectionId: Uint8Array;
    mode: 'connect' | 'pair';
    principalId: string;
    serverId: string;
    serverNonce: Uint8Array;
    serverPublicKey: Uint8Array;
}

export interface MobileSessionKeys {
    clientToServer: Uint8Array;
    confirmation: Uint8Array;
    serverToClient: Uint8Array;
    transcriptHash: Uint8Array;
}

export const mobilePublicKey = (secretKey: Uint8Array): Uint8Array => {
    if (secretKey.length !== X25519_KEY_BYTES) throw new Error('X25519 key length is invalid');
    return x25519.getPublicKey(secretKey);
};

const lengthPrefixed = (value: Uint8Array): Uint8Array => {
    if (value.length > 65_535) throw new Error('Transcript field is too long');
    return concatBytes(new Uint8Array([value.length >> 8, value.length & 0xff]), value);
};

/**
 * Compares authentication tags without returning on the first mismatched byte.
 */
const isConstantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
    return difference === 0;
};

const transcriptBytes = (input: HandshakeTranscript): Uint8Array => {
    if (
        input.clientNonce.length !== HANDSHAKE_NONCE_BYTES ||
        input.serverNonce.length !== HANDSHAKE_NONCE_BYTES
    )
        throw new Error('Handshake nonce length is invalid');
    if (
        input.clientPublicKey.length !== X25519_KEY_BYTES ||
        input.serverPublicKey.length !== X25519_KEY_BYTES
    )
        throw new Error('Handshake public key length is invalid');
    if (input.connectionId.length !== 16) throw new Error('Connection ID length is invalid');
    return concatBytes(
        DOMAIN,
        lengthPrefixed(utf8ToBytes(input.mode)),
        lengthPrefixed(utf8ToBytes(input.serverId)),
        lengthPrefixed(utf8ToBytes(input.principalId)),
        lengthPrefixed(input.connectionId),
        lengthPrefixed(input.clientPublicKey),
        lengthPrefixed(input.serverPublicKey),
        lengthPrefixed(input.clientNonce),
        lengthPrefixed(input.serverNonce),
    );
};

export const deriveMobileSessionKeys = (input: {
    localSecretKey: Uint8Array;
    peerPublicKey: Uint8Array;
    presharedKey: Uint8Array;
    transcript: HandshakeTranscript;
}): MobileSessionKeys => {
    if (
        input.localSecretKey.length !== X25519_KEY_BYTES ||
        input.peerPublicKey.length !== X25519_KEY_BYTES
    )
        throw new Error('X25519 key length is invalid');
    if (input.presharedKey.length !== PAIRING_SECRET_BYTES)
        throw new Error('Preshared key length is invalid');
    const transcriptHash = sha256(transcriptBytes(input.transcript));
    const sharedSecret = x25519.getSharedSecret(input.localSecretKey, input.peerPublicKey);
    const material = hkdf(
        sha256,
        concatBytes(sharedSecret, input.presharedKey),
        transcriptHash,
        concatBytes(DOMAIN, transcriptHash),
        SESSION_MATERIAL_BYTES,
    );
    return {
        clientToServer: material.slice(0, SESSION_KEY_BYTES),
        serverToClient: material.slice(SESSION_KEY_BYTES, 2 * SESSION_KEY_BYTES),
        confirmation: material.slice(2 * SESSION_KEY_BYTES),
        transcriptHash,
    };
};

export const handshakeConfirmation = (
    keys: Pick<MobileSessionKeys, 'confirmation' | 'transcriptHash'>,
    sender: 'client' | 'server',
): Uint8Array =>
    hmac(
        sha256,
        keys.confirmation,
        concatBytes(DOMAIN, utf8ToBytes(`confirmation:${sender}`), keys.transcriptHash),
    );

export const isHandshakeConfirmationValid = (
    actual: Uint8Array,
    keys: Pick<MobileSessionKeys, 'confirmation' | 'transcriptHash'>,
    sender: 'client' | 'server',
): boolean =>
    actual.length === 32 && isConstantTimeEqual(actual, handshakeConfirmation(keys, sender));

export const nonceForCounter = (
    direction: 'client-to-server' | 'server-to-client',
    counter: number,
): Uint8Array => {
    if (!Number.isSafeInteger(counter) || counter < 0 || counter > MOBILE_MAX_FRAME_COUNTER)
        throw new Error('Encrypted frame counter is out of range');
    const nonce = new Uint8Array(12);
    nonce[3] = direction === 'client-to-server' ? 1 : 2;
    const view = new DataView(nonce.buffer);
    view.setUint32(4, Math.floor(counter / 2 ** 32));
    view.setUint32(8, counter >>> 0);
    return nonce;
};

export const additionalDataForFrame = (input: {
    connectionId: Uint8Array;
    counter: number;
    deviceId: string;
    direction: 'client-to-server' | 'server-to-client';
}): Uint8Array => {
    if (input.connectionId.length !== 16) throw new Error('Connection ID length is invalid');
    return concatBytes(
        DOMAIN,
        lengthPrefixed(input.connectionId),
        lengthPrefixed(utf8ToBytes(input.deviceId)),
        nonceForCounter(input.direction, input.counter),
    );
};
