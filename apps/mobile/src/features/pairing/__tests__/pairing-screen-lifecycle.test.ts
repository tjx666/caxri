import { describe, expect, it } from 'vitest';

import {
    MobilePairingCancelledError,
    MobilePairingError,
} from '../../connection/mobile-gateway-client';
import { completePairing, readPairingLink } from '../pairing-screen-lifecycle';

describe('pairing screen lifecycle', () => {
    it('navigates only after an active pairing completes', async () => {
        let isNavigated = false;
        let error: string | undefined;

        await completePairing(
            async () => {},
            () => true,
            () => {
                isNavigated = true;
            },
            (message) => {
                error = message;
            },
        );

        expect(isNavigated).toBe(true);
        expect(error).toBeUndefined();
    });

    it('ignores cancellation after a screen leaves', async () => {
        let isNavigated = false;
        let error: string | undefined;

        await completePairing(
            () => Promise.reject(new MobilePairingCancelledError()),
            () => true,
            () => {
                isNavigated = true;
            },
            (message) => {
                error = message;
            },
        );

        expect(isNavigated).toBe(false);
        expect(error).toBeUndefined();
    });

    it('keeps malformed route parameters on the pairing error path', () => {
        let error: string | undefined;

        expect(readPairingLink({}, (message) => (error = message))).toBeNull();
        expect(error).toBe('Pairing failed. Create a new code in Caxri Settings and try again.');
    });

    it('maps a failed pairing to the screen error without navigating', async () => {
        let isNavigated = false;
        let error: string | undefined;

        await completePairing(
            () => Promise.reject(new MobilePairingError('expired', 'expired')),
            () => true,
            () => {
                isNavigated = true;
            },
            (message) => {
                error = message;
            },
        );

        expect(isNavigated).toBe(false);
        expect(error).toBe('This pairing code expired. Create a new code in Caxri Settings.');
    });
});
