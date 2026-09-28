import { describe, expect, it } from 'vitest';

import { decodeHex, encodeHex } from '../encoding';
import {
    deriveMobileUpdateRecoveryKey,
    isMobileUpdateRecoveryProofEqual,
    MOBILE_UPDATE_RECOVERY_PROTOCOL,
    mobileUpdateRecoveryClientProof,
    mobileUpdateRecoveryHelloSchema,
    mobileUpdateRecoveryPayloadSchema,
    mobileUpdateRecoveryServerProof,
} from '../update-recovery';

const credential = decodeHex('11'.repeat(32));
const transcript = {
    clientNonce: decodeHex('22'.repeat(32)),
    deviceId: 'device_test',
    generation: 1,
    serverId: 'server_test',
    serverNonce: decodeHex('33'.repeat(32)),
};

describe('mobile update recovery v1', () => {
    it('keeps the frozen v1 key and proof bytes', () => {
        const key = deriveMobileUpdateRecoveryKey({ credential, transcript });
        const payload = '{"bundle":null}';
        // These vectors pin the wire contract that already-installed phones speak; a transport version bump must not
        // move them.
        expect({
            clientProof: encodeHex(mobileUpdateRecoveryClientProof(key)),
            key: encodeHex(key),
            protocol: MOBILE_UPDATE_RECOVERY_PROTOCOL,
            serverProof: encodeHex(mobileUpdateRecoveryServerProof(key, payload)),
        }).toEqual({
            clientProof: 'c0e04b320af57469b61eabdd829e1e3a25a337a511b3e19ba1908f4163ae8a17',
            key: '384c2912dec992ee7acd3b7db4d8c5708297196a19f660401c6c6b662e0f2d82',
            protocol: 'update-recovery-v1',
            serverProof: '38bef7f95f0e6cf53f8e82cbee6123f48ae286c64776ddfd314939b6b49d6670',
        });
    });

    it('binds the proof to both nonces, the device generation, and the Desktop identity', () => {
        const proofFor = (input: { credential: Uint8Array; transcript: typeof transcript }) =>
            mobileUpdateRecoveryClientProof(deriveMobileUpdateRecoveryKey(input));
        const proof = proofFor({ credential, transcript });
        const variants = [
            { credential, transcript: { ...transcript, clientNonce: decodeHex('44'.repeat(32)) } },
            { credential, transcript: { ...transcript, serverNonce: decodeHex('44'.repeat(32)) } },
            { credential, transcript: { ...transcript, generation: 2 } },
            { credential, transcript: { ...transcript, serverId: 'server_other' } },
            { credential, transcript: { ...transcript, deviceId: 'device_other' } },
            { credential: decodeHex('12'.repeat(32)), transcript },
        ];
        for (const variant of variants)
            expect(isMobileUpdateRecoveryProofEqual(proof, proofFor(variant))).toBe(false);
        expect(isMobileUpdateRecoveryProofEqual(proof, proofFor({ credential, transcript }))).toBe(
            true,
        );
    });

    it('separates client and server proofs and authenticates the exact payload text', () => {
        const key = deriveMobileUpdateRecoveryKey({ credential, transcript });
        const payload = '{"bundle":null}';
        const serverProof = mobileUpdateRecoveryServerProof(key, payload);
        expect(
            isMobileUpdateRecoveryProofEqual(serverProof, mobileUpdateRecoveryClientProof(key)),
        ).toBe(false);
        expect(
            isMobileUpdateRecoveryProofEqual(
                serverProof,
                mobileUpdateRecoveryServerProof(key, '{"bundle": null}'),
            ),
        ).toBe(false);
        expect(
            isMobileUpdateRecoveryProofEqual(
                serverProof,
                mobileUpdateRecoveryServerProof(key, payload),
            ),
        ).toBe(true);
    });

    it('tolerates additive fields so a later Desktop can extend v1 without stranding this phone', () => {
        expect(
            mobileUpdateRecoveryHelloSchema.parse({
                type: 'update-recovery-hello',
                protocol: 'update-recovery-v1',
                deviceId: 'device_test',
                generation: 1,
                clientNonce: '22'.repeat(32),
                future: true,
            }),
        ).not.toHaveProperty('future');
        expect(
            mobileUpdateRecoveryPayloadSchema.parse({
                bundle: {
                    version: '0.0.77',
                    versionCode: 77,
                    sizeBytes: 1,
                    md5: 'a'.repeat(32),
                    abi: 'arm64-v8a',
                },
                url: `http://192.168.1.5:41337/mobile/update/${'b'.repeat(64)}`,
                expiresAt: 1,
            }),
        ).toEqual({
            bundle: { version: '0.0.77', versionCode: 77, sizeBytes: 1, md5: 'a'.repeat(32) },
            url: `http://192.168.1.5:41337/mobile/update/${'b'.repeat(64)}`,
            expiresAt: 1,
        });
        expect(mobileUpdateRecoveryPayloadSchema.parse({ bundle: null })).toEqual({ bundle: null });
        expect(() =>
            mobileUpdateRecoveryPayloadSchema.parse({
                bundle: { version: '0.0.77', versionCode: 77, sizeBytes: 1, md5: 'a'.repeat(32) },
                url: 'https://example.com/caxri.apk',
                expiresAt: 1,
            }),
        ).toThrow();
    });
});
