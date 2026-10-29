import { describe, expect, it } from 'vitest';

import { MobileRelayUnavailableError } from '../../connection/gateway-routes';
import {
    MobilePairingError,
    MobileVersionMismatchError,
} from '../../connection/mobile-gateway-client';
import { pairingErrorMessage } from '../pairing-error';

describe('pairingErrorMessage', () => {
    it('uses the update-required copy for an incompatible pairing link or Server', () => {
        expect(pairingErrorMessage(new MobileVersionMismatchError())).toBe(
            'Update required. This app and Caxri on your computer use different versions. Update both to the latest build.',
        );
    });

    it.each([
        [
            'expired',
            'This pairing code expired. On your computer, open Caxri Settings → Mobile and choose Create pairing code.',
        ],
        ['invalid-link', 'This is not a valid Caxri pairing link. Copy or scan a new code.'],
        [
            'unreachable',
            'Caxri could not be reached. Keep Caxri running on your computer with Mobile access on, then join the same network, or use Tailscale or a Relay when away from home.',
        ],
        [
            'rejected',
            'Pairing was rejected. A pairing code works once and cannot be reused. On your computer, open Caxri Settings → Mobile, choose Create pairing code, and try again.',
        ],
    ] as const)('maps %s without exposing credential details', (code, expected) => {
        expect(pairingErrorMessage(new MobilePairingError(code, 'private detail'))).toBe(expected);
    });

    it('uses the non-specific recovery copy for an unknown failure', () => {
        expect(pairingErrorMessage(new Error('private detail'))).toBe(
            'Pairing failed. On your computer, open Caxri Settings → Mobile, choose Create pairing code, and try again.',
        );
    });

    it.each([
        [
            'host-offline',
            'Caxri on your computer is offline. Open Caxri on your computer, then try again.',
        ],
        [
            'host-timeout',
            'Caxri on your computer is offline. Open Caxri on your computer, then try again.',
        ],
        [
            'unauthorized',
            'The Relay does not accept this phone. On your computer, open Caxri Settings → Mobile and choose Create pairing code to pair again.',
        ],
        ['capacity', 'The Relay is busy. Wait a moment and try again.'],
        ['rate-limited', 'The Relay is busy. Wait a moment and try again.'],
    ] as const)('names the Relay refusal %s', (reason, expected) => {
        expect(pairingErrorMessage(new MobileRelayUnavailableError(reason))).toBe(expected);
    });

    it('keeps the generic unreachable copy for an unspecific Relay failure', () => {
        expect(pairingErrorMessage(new MobileRelayUnavailableError('unreachable'))).toContain(
            'Caxri could not be reached.',
        );
    });
});
