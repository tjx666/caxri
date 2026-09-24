import { describe, expect, it } from 'vitest';

import {
    MOBILE_GATEWAY_MAX_FRAME_BYTES,
    MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES,
    MOBILE_GATEWAY_MAX_WIRE_BYTES,
    MOBILE_TRANSPORT_VERSION,
    mobileSealedFrameSchema,
} from '../contract';
import { encodeHex } from '../encoding';
import {
    MOBILE_STREAM_CHUNK_MAX_BYTES,
    mobileClientPayloadSchema,
    mobileServerPayloadSchema,
    mobileSubscribeResultSchema,
} from '../messages';
import { sealMobileFrame } from '../sealed-frame';

describe('mobile application messages', () => {
    it('validates a generation-fenced Terminal snapshot, ordered output, and source-gap recovery', () => {
        const snapshot = {
            type: 'stream',
            subscriptionId: 'subscription-1',
            sequence: 0,
            kind: 'terminal.snapshot',
            generation: 3,
            nextHostSequence: 7,
            chunkIndex: 0,
            chunkCount: 1,
            chunkHex: '6e756c6c',
        };
        const output = {
            type: 'stream',
            subscriptionId: 'subscription-1',
            sequence: 1,
            kind: 'terminal.output',
            generation: 3,
            hostSequence: 7,
            chunkIndex: 0,
            chunkCount: 1,
            chunkHex: '6162',
        };
        expect(mobileServerPayloadSchema.safeParse(snapshot).success).toBe(true);
        expect(mobileServerPayloadSchema.safeParse(output).success).toBe(true);
        expect(
            mobileServerPayloadSchema.safeParse({
                type: 'event',
                subscriptionId: 'subscription-1',
                sequence: 2,
                kind: 'resync-required',
                reason: 'source-gap',
            }).success,
        ).toBe(true);
        expect(mobileServerPayloadSchema.safeParse({ ...output, generation: 0 }).success).toBe(
            false,
        );
        expect(mobileServerPayloadSchema.safeParse({ ...output, chunkIndex: 1 }).success).toBe(
            false,
        );
    });
    it('validates subscription controls and acknowledgements without importing command protocol', () => {
        expect(
            mobileClientPayloadSchema.parse({
                type: 'subscribe',
                id: 'subscribe-1',
                resource: { kind: 'terminal', terminalId: 'terminal-1' },
            }),
        ).toMatchObject({ type: 'subscribe', id: 'subscribe-1' });
        expect(mobileSubscribeResultSchema.parse({ subscriptionId: 'subscription-1' })).toEqual({
            subscriptionId: 'subscription-1',
        });
        expect(
            mobileClientPayloadSchema.safeParse({
                type: 'subscribe',
                id: 'subscribe-1',
                resource: { kind: 'terminal', terminalId: 'terminal-1', projectId: 'leak' },
            }).success,
        ).toBe(false);
    });

    it('routes reply, event, stream, heartbeat acknowledgement, and revocation as distinct frames', () => {
        const messages = [
            { type: 'reply', reply: { id: 'request-1' } },
            {
                type: 'event',
                subscriptionId: 'subscription-1',
                sequence: 0,
                kind: 'dashboard.changed',
            },
            {
                type: 'stream',
                subscriptionId: 'subscription-2',
                sequence: 1,
                kind: 'terminal.output',
                generation: 1,
                hostSequence: 0,
                chunkIndex: 0,
                chunkCount: 1,
                chunkHex: '6162',
            },
            { type: 'heartbeat-ack', nonce: 'aa'.repeat(16) },
            { type: 'revoked', deviceId: `device_${'44'.repeat(16)}`, generation: 1 },
        ];
        expect(messages.map((message) => mobileServerPayloadSchema.parse(message).type)).toEqual(
            messages.map((message) => message.type),
        );
        expect(
            mobileServerPayloadSchema.safeParse({
                type: 'event',
                subscriptionId: 'subscription-1',
                sequence: -1,
                kind: 'dashboard.changed',
            }).success,
        ).toBe(false);
    });

    it('keeps a maximum stream chunk below the sealed plaintext cap with worst-case metadata', () => {
        const payload = mobileServerPayloadSchema.parse({
            type: 'stream',
            subscriptionId: 's'.repeat(200),
            sequence: Number.MAX_SAFE_INTEGER,
            kind: 'terminal.output',
            generation: Number.MAX_SAFE_INTEGER,
            hostSequence: Number.MAX_SAFE_INTEGER,
            chunkIndex: 0,
            chunkCount: 1,
            chunkHex: 'ab'.repeat(MOBILE_STREAM_CHUNK_MAX_BYTES),
        });
        expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(
            MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES,
        );
        const ciphertext = sealMobileFrame(
            new Uint8Array(32).fill(7),
            {
                connectionId: new Uint8Array(16).fill(8),
                counter: 2 ** 48 - 1,
                deviceId: 'd'.repeat(200),
                direction: 'server-to-client',
            },
            new TextEncoder().encode(JSON.stringify(payload)),
        );
        expect(ciphertext.length).toBeLessThanOrEqual(MOBILE_GATEWAY_MAX_FRAME_BYTES);
        const frame = mobileSealedFrameSchema.parse({
            type: 'sealed',
            version: MOBILE_TRANSPORT_VERSION,
            connectionId: '08'.repeat(16),
            counter: 2 ** 48 - 1,
            ciphertext: encodeHex(ciphertext),
        });
        expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThanOrEqual(
            MOBILE_GATEWAY_MAX_WIRE_BYTES,
        );
        expect(
            mobileServerPayloadSchema.safeParse({
                ...payload,
                chunkHex: 'ab'.repeat(MOBILE_STREAM_CHUNK_MAX_BYTES + 1),
            }).success,
        ).toBe(false);
    });
});
