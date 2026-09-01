import { gcm } from '@noble/ciphers/aes.js';

import {
    MOBILE_GATEWAY_MAX_FRAME_BYTES,
    MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES,
    SESSION_KEY_BYTES,
} from './contract.js';
import { additionalDataForFrame, nonceForCounter } from './session-keys.js';

export interface MobileFrameContext {
    connectionId: Uint8Array;
    counter: number;
    deviceId: string;
    direction: 'client-to-server' | 'server-to-client';
}

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
    if (plaintext.length > MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES)
        throw new Error('Mobile frame is too large');
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
