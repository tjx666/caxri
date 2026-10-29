import { describe, expect, it } from 'vitest';

import { decodeHex, encodeHex } from '../encoding';
import {
    createRelayHostKey,
    isRelayHostProofValid,
    isRelayUrl,
    relayAccessKey,
    relayAccessKeyHash,
    relayAccessKeyHashFromHex,
    relayCloseCodes,
    relayCloseReasonOf,
    relayEndpoint,
    relayHostIdForPublicKey,
    relayHostPublicKey,
    relayHostRegisterSchema,
    relayPaths,
    signRelayHostChallenge,
} from '../relay';

const challenge = new Uint8Array(32).fill(7);

describe('relay host proof', () => {
    it('verifies only a signature from the key the host ID derives from', () => {
        const host = createRelayHostKey();
        const other = createRelayHostKey();
        const signature = signRelayHostChallenge(host.secretKey, challenge);

        expect(relayHostPublicKey(host.secretKey)).toEqual(host.publicKey);
        expect(relayHostIdForPublicKey(host.publicKey)).toMatch(/^[0-9a-f]{32}$/u);
        expect(relayHostIdForPublicKey(host.publicKey)).not.toBe(
            relayHostIdForPublicKey(other.publicKey),
        );
        expect(isRelayHostProofValid({ challenge, publicKey: host.publicKey, signature })).toBe(
            true,
        );
        expect(isRelayHostProofValid({ challenge, publicKey: other.publicKey, signature })).toBe(
            false,
        );
        expect(
            isRelayHostProofValid({
                challenge: new Uint8Array(32).fill(8),
                publicKey: host.publicKey,
                signature,
            }),
        ).toBe(false);
        expect(
            relayHostRegisterSchema.safeParse({
                type: 'host-register',
                version: 1,
                publicKey: encodeHex(host.publicKey),
                signature: encodeHex(signature),
                grants: [],
            }).success,
        ).toBe(true);
    });
});

describe('relay access keys', () => {
    it('separates device and pairing purposes and never exposes the source secret', () => {
        const secret = new Uint8Array(32).fill(3);
        const device = relayAccessKey(secret, 'device');
        const pairing = relayAccessKey(secret, 'pairing');

        expect(device).not.toEqual(pairing);
        expect(device).not.toEqual(secret);
        expect(relayAccessKeyHash(device)).toBe(relayAccessKeyHashFromHex(encodeHex(device)));
        expect(relayAccessKeyHash(device)).not.toBe(encodeHex(device));
        expect(() => relayAccessKey(new Uint8Array(16), 'device')).toThrow();
        expect(decodeHex(relayAccessKeyHash(device))).toHaveLength(32);
    });
});

describe('relay URLs', () => {
    it.each(['wss://relay.example.com', 'ws://192.168.1.2:8080', 'wss://example.com/prefix/'])(
        'accepts %s',
        (value) => expect(isRelayUrl(value)).toBe(true),
    );

    it.each([
        'https://relay.example.com',
        'wss://user:pass@relay.example.com',
        'wss://relay.example.com?token=1',
        'wss://relay.example.com#x',
        'not a url',
        `wss://${'a'.repeat(600)}.com`,
    ])('rejects %s', (value) => expect(isRelayUrl(value)).toBe(false));

    it('keeps a base path prefix when joining endpoints', () => {
        expect(relayEndpoint('wss://example.com/prefix/', relayPaths.client)).toBe(
            'wss://example.com/prefix/v1/client',
        );
        expect(relayEndpoint('ws://127.0.0.1:8080', relayPaths.host)).toBe(
            'ws://127.0.0.1:8080/v1/host',
        );
    });
});

describe('relay close codes', () => {
    it('round-trips every reason and stays clear of the phone close range', () => {
        for (const [reason, code] of Object.entries(relayCloseCodes)) {
            expect(relayCloseReasonOf(code)).toBe(reason);
            expect(code).toBeGreaterThanOrEqual(4400);
            expect(code).toBeLessThan(4600);
        }
        expect(relayCloseReasonOf(4001)).toBeUndefined();
    });
});
