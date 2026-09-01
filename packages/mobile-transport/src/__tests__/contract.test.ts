import { describe, expect, it } from 'vitest';

import { mobileClientHelloSchema, mobileRevokedSchema } from '../contract';

const pairHello = {
    type: 'hello',
    version: 1,
    mode: 'pair',
    pairingId: '11'.repeat(16),
    displayName: 'Test tablet',
    platform: 'android',
    clientPublicKey: '22'.repeat(32),
    clientNonce: '33'.repeat(32),
} as const;

describe('mobile transport contract', () => {
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
