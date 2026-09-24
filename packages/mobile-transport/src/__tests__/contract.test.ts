import { describe, expect, it } from 'vitest';

import {
    isPrivateMobileIpv4Address,
    MOBILE_TRANSPORT_VERSION,
    mobileClientHelloSchema,
    mobileRevokedSchema,
    mobileVersionMismatchSchema,
} from '../contract';

const pairHello = {
    type: 'hello',
    version: MOBILE_TRANSPORT_VERSION,
    mode: 'pair',
    pairingId: '11'.repeat(16),
    displayName: 'Test tablet',
    platform: 'android',
    clientPublicKey: '22'.repeat(32),
    clientNonce: '33'.repeat(32),
} as const;

describe('mobile transport contract', () => {
    it.each([
        ['10.0.0.1', true],
        ['172.16.0.1', true],
        ['192.168.1.1', true],
        ['127.0.0.1', true],
        ['100.64.0.0', true],
        ['100.127.255.255', true],
        ['100.63.255.255', false],
        ['100.128.0.0', false],
        ['203.0.113.1', false],
    ])('classifies mobile gateway address %s', (address, allowed) => {
        expect(isPrivateMobileIpv4Address(address)).toBe(allowed);
    });

    it('recognizes only a bounded version mismatch response', () => {
        expect(
            mobileVersionMismatchSchema.parse({ type: 'version-mismatch', supportedVersion: 1 }),
        ).toEqual({ type: 'version-mismatch', supportedVersion: 1 });
        expect(
            mobileVersionMismatchSchema.safeParse({
                type: 'version-mismatch',
                supportedVersion: 1,
                credential: 'unexpected',
            }).success,
        ).toBe(false);
    });

    it('accepts only a generation-bound revoked control payload', () => {
        expect(
            mobileRevokedSchema.parse({
                type: 'revoked',
                deviceId: `device_${'44'.repeat(16)}`,
                generation: 1,
            }),
        ).toEqual({
            type: 'revoked',
            deviceId: `device_${'44'.repeat(16)}`,
            generation: 1,
        });
        expect(
            mobileRevokedSchema.safeParse({
                type: 'revoked',
                deviceId: `device_${'44'.repeat(16)}`,
                generation: 1,
                reason: 'leaked detail',
            }).success,
        ).toBe(false);
    });

    it.each(['Tablet\nApprove', 'Tablet\u{202E}Approve'])(
        'rejects a misleading device name',
        (displayName) => {
            expect(mobileClientHelloSchema.safeParse({ ...pairHello, displayName }).success).toBe(
                false,
            );
        },
    );
});
