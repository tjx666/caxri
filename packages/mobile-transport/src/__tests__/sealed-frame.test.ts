import { describe, expect, it } from 'vitest';

import { MOBILE_GATEWAY_MAX_FRAME_BYTES } from '../contract';
import { decodeHex, encodeHex } from '../encoding';
import {
    MobileFrameCounter,
    MobileReplayGuard,
    openMobileFrame,
    sealMobileFrame,
} from '../sealed-frame';

const key = decodeHex('a5'.repeat(32));
const connectionId = decodeHex('b6'.repeat(16));
const plaintext = new TextEncoder().encode('{"method":"session.list"}');
const context = {
    connectionId,
    counter: 0,
    deviceId: 'device_test',
    direction: 'client-to-server' as const,
};

describe('sealed mobile frames', () => {
    it('round-trips a deterministic AES-256-GCM frame', () => {
        const ciphertext = sealMobileFrame(key, context, plaintext);
        expect(encodeHex(ciphertext)).toBe(
            'c0b5d5e55e2e19722af76979a26000a03a7150b884131d2d68cb085f45f589db3121a824e63e969719',
        );
        expect(openMobileFrame(key, context, ciphertext)).toEqual(plaintext);
    });

    it('rejects tampered ciphertext or authenticated context', () => {
        const ciphertext = sealMobileFrame(key, context, plaintext);
        ciphertext[0] = ciphertext[0]! ^ 1;
        expect(() => openMobileFrame(key, context, ciphertext)).toThrow();

        const valid = sealMobileFrame(key, context, plaintext);
        expect(() =>
            openMobileFrame(key, { ...context, deviceId: 'device_other' }, valid),
        ).toThrow();
    });

    it('enforces the frame limit and exact monotonic counters', () => {
        expect(() =>
            sealMobileFrame(key, context, new Uint8Array(MOBILE_GATEWAY_MAX_FRAME_BYTES)),
        ).toThrow('Mobile frame is too large');

        const outbound = new MobileFrameCounter();
        expect([outbound.take(), outbound.take()]).toEqual([0, 1]);

        const inbound = new MobileReplayGuard();
        inbound.assertAndAdvance(0);
        expect(() => inbound.assertAndAdvance(0)).toThrow('Encrypted frame counter is not next');
        expect(() => inbound.assertAndAdvance(2)).toThrow('Encrypted frame counter is not next');
        inbound.assertAndAdvance(1);
    });
});
