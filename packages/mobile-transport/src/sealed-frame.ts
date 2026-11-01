import { gcm } from '@noble/ciphers/aes.js';

import {
    MOBILE_GATEWAY_MAX_FRAME_BYTES,
    MOBILE_MAX_FRAME_COUNTER,
    MOBILE_SEALED_FRAME_HEADER_BYTES,
    MOBILE_SEALED_PLAINTEXT_PREFIX_BYTES,
    MOBILE_TRANSPORT_VERSION,
    SESSION_KEY_BYTES,
} from './contract.js';
import { additionalDataForFrame, nonceForCounter } from './session-keys.js';

export interface MobileFrameContext {
    connectionId: Uint8Array;
    counter: number;
    deviceId: string;
    direction: 'client-to-server' | 'server-to-client';
}

const MAX_SEALED_PLAINTEXT_BYTES = MOBILE_GATEWAY_MAX_FRAME_BYTES - gcm.tagLength;
const COUNTER_HIGH_FACTOR = 2 ** 32;
const CHUNK_FLAG = 1;

const frameCipher = (key: Uint8Array, context: MobileFrameContext) => {
    if (key.length !== SESSION_KEY_BYTES) throw new Error('Session key length is invalid');
    return gcm(
        key,
        nonceForCounter(context.direction, context.counter),
        additionalDataForFrame(context),
    );
};

export const sealMobileFrame = (
    key: Uint8Array,
    context: MobileFrameContext,
    plaintext: Uint8Array,
): Uint8Array => {
    if (plaintext.length > MAX_SEALED_PLAINTEXT_BYTES) throw new Error('Mobile frame is too large');
    return frameCipher(key, context).encrypt(plaintext);
};

export const openMobileFrame = (
    key: Uint8Array,
    context: MobileFrameContext,
    ciphertext: Uint8Array,
): Uint8Array => {
    if (ciphertext.length < gcm.tagLength || ciphertext.length > MOBILE_GATEWAY_MAX_FRAME_BYTES)
        throw new Error('Sealed mobile frame size is invalid');
    return frameCipher(key, context).decrypt(ciphertext);
};

/**
 * Wraps a ciphertext as one binary WebSocket message: `[version u8][counter u48 BE][ciphertext]`. The connection ID is
 * not repeated per frame because the AES-GCM additional data already binds it, so a frame moved to another connection
 * fails authentication.
 */
export const encodeSealedFrame = (
    counter: number,
    ciphertext: Uint8Array,
): Uint8Array<ArrayBuffer> => {
    if (!Number.isSafeInteger(counter) || counter < 0 || counter > MOBILE_MAX_FRAME_COUNTER)
        throw new Error('Encrypted frame counter is outside its range');
    const frame = new Uint8Array(MOBILE_SEALED_FRAME_HEADER_BYTES + ciphertext.length);
    const view = new DataView(frame.buffer);
    view.setUint8(0, MOBILE_TRANSPORT_VERSION);
    view.setUint16(1, Math.floor(counter / COUNTER_HIGH_FACTOR));
    view.setUint32(3, counter % COUNTER_HIGH_FACTOR);
    frame.set(ciphertext, MOBILE_SEALED_FRAME_HEADER_BYTES);
    return frame;
};

/**
 * Splits one binary WebSocket message into its counter and ciphertext; the caller checks the counter before opening.
 */
export const decodeSealedFrame = (
    frame: Uint8Array,
): { ciphertext: Uint8Array; counter: number } => {
    const ciphertextLength = frame.length - MOBILE_SEALED_FRAME_HEADER_BYTES;
    if (ciphertextLength < gcm.tagLength || ciphertextLength > MOBILE_GATEWAY_MAX_FRAME_BYTES)
        throw new Error('Sealed mobile frame size is invalid');
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (view.getUint8(0) !== MOBILE_TRANSPORT_VERSION)
        throw new Error('Sealed mobile frame version is unsupported');
    return {
        ciphertext: frame.subarray(MOBILE_SEALED_FRAME_HEADER_BYTES),
        counter: view.getUint16(1) * COUNTER_HIGH_FACTOR + view.getUint32(3),
    };
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Encodes an application payload as `[flags u8][jsonLength u32 BE][UTF-8 JSON][chunk bytes]`. A top-level `chunk`
 * `Uint8Array` (a Terminal stream chunk) travels as raw trailing bytes rather than text-encoded inside the JSON; the
 * earlier hex encoding, sealed and hex encoded again, put every Terminal byte on the wire four times over.
 */
export const encodeMobilePlaintext = (payload: unknown): Uint8Array => {
    const chunk = isRecord(payload) && payload.chunk instanceof Uint8Array ? payload.chunk : null;
    const json = textEncoder.encode(
        JSON.stringify(chunk ? { ...(payload as object), chunk: undefined } : payload),
    );
    const plaintext = new Uint8Array(
        MOBILE_SEALED_PLAINTEXT_PREFIX_BYTES + json.length + (chunk?.length ?? 0),
    );
    const view = new DataView(plaintext.buffer);
    view.setUint8(0, chunk ? CHUNK_FLAG : 0);
    view.setUint32(1, json.length);
    plaintext.set(json, MOBILE_SEALED_PLAINTEXT_PREFIX_BYTES);
    if (chunk) plaintext.set(chunk, MOBILE_SEALED_PLAINTEXT_PREFIX_BYTES + json.length);
    return plaintext;
};

export const decodeMobilePlaintext = (plaintext: Uint8Array): unknown => {
    if (plaintext.length < MOBILE_SEALED_PLAINTEXT_PREFIX_BYTES)
        throw new Error('Sealed mobile plaintext is truncated');
    const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    const flags = view.getUint8(0);
    const jsonEnd = MOBILE_SEALED_PLAINTEXT_PREFIX_BYTES + view.getUint32(1);
    if ((flags & ~CHUNK_FLAG) !== 0 || jsonEnd > plaintext.length)
        throw new Error('Sealed mobile plaintext layout is invalid');
    const payload: unknown = JSON.parse(
        textDecoder.decode(plaintext.subarray(MOBILE_SEALED_PLAINTEXT_PREFIX_BYTES, jsonEnd)),
    );
    if (flags === 0) {
        if (jsonEnd !== plaintext.length)
            throw new Error('Sealed mobile plaintext layout is invalid');
        return payload;
    }
    if (!isRecord(payload) || 'chunk' in payload)
        throw new Error('Sealed mobile plaintext layout is invalid');
    // A copy, so the chunk does not keep the whole decrypted frame alive.
    return { ...payload, chunk: plaintext.slice(jsonEnd) };
};

/**
 * Seals one application payload into the binary WebSocket message for `context.counter`.
 */
export const sealMobilePayload = (
    key: Uint8Array,
    context: MobileFrameContext,
    payload: unknown,
): Uint8Array<ArrayBuffer> =>
    encodeSealedFrame(
        context.counter,
        sealMobileFrame(key, context, encodeMobilePlaintext(payload)),
    );

/**
 * Opens a ciphertext from `decodeSealedFrame` once its counter has passed the replay guard.
 */
export const openMobilePayload = (
    key: Uint8Array,
    context: MobileFrameContext,
    ciphertext: Uint8Array,
): unknown => decodeMobilePlaintext(openMobileFrame(key, context, ciphertext));

/**
 * WebSocket delivery is ordered, so accepting only the exact next counter rejects replayed frames.
 */
export class MobileReplayGuard {
    #nextCounter = 0;

    assertAndAdvance(counter: number): void {
        if (counter !== this.#nextCounter) throw new Error('Encrypted frame counter is not next');
        nonceForCounter('client-to-server', counter);
        this.#nextCounter += 1;
    }
}

export class MobileFrameCounter {
    #nextCounter = 0;

    take(): number {
        const counter = this.#nextCounter;
        nonceForCounter('server-to-client', counter);
        this.#nextCounter += 1;
        return counter;
    }
}
