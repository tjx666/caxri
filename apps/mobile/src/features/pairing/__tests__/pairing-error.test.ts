import { describe, expect, it } from 'vitest';

import { MobilePairingError } from '../../connection/mobile-gateway-client';
import { pairingErrorMessage } from '../pairing-error';

describe('pairingErrorMessage', () => {
    it.each([
        ['expired', 'This pairing code expired. Create a new code in Caxri Settings.'],
        ['invalid-link', 'This is not a valid Caxri pairing link. Copy or scan a new code.'],
        [
            'unreachable',
            'Caxri could not be reached. Check that Mobile access is on and both devices are on the same network.',
        ],
        ['rejected', 'Pairing was rejected. Create a new code in Caxri Settings and try again.'],
    ] as const)('maps %s without exposing credential details', (code, expected) => {
        expect(pairingErrorMessage(new MobilePairingError(code, 'private detail'))).toBe(expected);
    });

    it('uses the non-specific recovery copy for an unknown failure', () => {
        expect(pairingErrorMessage(new Error('private detail'))).toBe(
            'Pairing failed. Create a new code in Caxri Settings and try again.',
        );
    });
});
