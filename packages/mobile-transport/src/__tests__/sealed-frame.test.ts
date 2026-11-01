import { describe, expect, it } from 'vitest';

import { MOBILE_GATEWAY_MAX_FRAME_BYTES, MOBILE_TRANSPORT_VERSION } from '../contract';
import { decodeHex, encodeHex } from '../encoding';
import {
    decodeMobilePlaintext,
    decodeSealedFrame,
    encodeMobilePlaintext,
    encodeSealedFrame,
    MobileFrameCounter,
    MobileReplayGuard,
    openMobileFrame,
    openMobilePayload,
    sealMobileFrame,
    sealMobilePayload,
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
            'c0b5d5e55e2e19722af76979a26000a03a7150b884131d2d6847861cac01c4869b83bb3ecbf32a8b2c',
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

    it('carries a payload and its raw Terminal chunk in one binary frame', () => {
        const chunk = new Uint8Array([0, 1, 0xfe, 0xff]);
        const payload = { type: 'stream', kind: 'terminal.output', chunk };
        const frame = sealMobilePayload(key, { ...context, counter: 2 ** 48 - 1 }, payload);
        expect(frame[0]).toBe(MOBILE_TRANSPORT_VERSION);
        // Raw bytes, not their hex text: the frame is the chunk plus a small fixed overhead.
        expect(frame.length).toBeLessThan(chunk.length + 100);
        const { ciphertext, counter } = decodeSealedFrame(frame);
        expect(counter).toBe(2 ** 48 - 1);
        expect(openMobilePayload(key, { ...context, counter }, ciphertext)).toEqual(payload);
        expect(() =>
            openMobilePayload(
                key,
                { ...context, counter, connectionId: new Uint8Array(16) },
                ciphertext,
            ),
        ).toThrow();

        const empty = { type: 'stream', chunk: new Uint8Array() };
        expect(decodeMobilePlaintext(encodeMobilePlaintext(empty))).toEqual(empty);
        expect(decodeMobilePlaintext(encodeMobilePlaintext({ type: 'reply', reply: 1 }))).toEqual({
            type: 'reply',
            reply: 1,
        });
    });

    it('rejects malformed binary frames and plaintext layouts', () => {
        const frame = encodeSealedFrame(3, new Uint8Array(16));
        expect(decodeSealedFrame(frame).counter).toBe(3);
        expect(() => decodeSealedFrame(frame.subarray(0, -1))).toThrow(
            'Sealed mobile frame size is invalid',
        );
        const otherVersion = frame.slice();
        otherVersion[0] = MOBILE_TRANSPORT_VERSION - 1;
        expect(() => decodeSealedFrame(otherVersion)).toThrow('version is unsupported');
        expect(() => encodeSealedFrame(2 ** 48, new Uint8Array(16))).toThrow('outside its range');

        const plain = encodeMobilePlaintext({ type: 'reply' });
        expect(() => decodeMobilePlaintext(plain.subarray(0, 4))).toThrow('truncated');
        const trailing = new Uint8Array([...plain, 1]);
        expect(() => decodeMobilePlaintext(trailing)).toThrow('layout is invalid');
        const unknownFlag = plain.slice();
        unknownFlag[0] = 2;
        expect(() => decodeMobilePlaintext(unknownFlag)).toThrow('layout is invalid');
        const duplicateChunk = encodeMobilePlaintext({ chunk: 1 });
        duplicateChunk[0] = 1;
        expect(() => decodeMobilePlaintext(duplicateChunk)).toThrow('layout is invalid');
        const overlongJson = plain.slice();
        overlongJson[4] = 0xff;
        expect(() => decodeMobilePlaintext(overlongJson)).toThrow('layout is invalid');
    });
});
