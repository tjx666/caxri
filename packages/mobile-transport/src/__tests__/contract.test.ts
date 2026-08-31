import { describe, expect, it } from 'vitest';

import { mobileClientHelloSchema } from '../contract';

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
    it.each(['Tablet\nApprove', 'Tablet\u{202E}Approve'])(
        'rejects a misleading device name',
        (displayName) => {
            expect(mobileClientHelloSchema.safeParse({ ...pairHello, displayName }).success).toBe(
                false,
            );
        },
    );
});
