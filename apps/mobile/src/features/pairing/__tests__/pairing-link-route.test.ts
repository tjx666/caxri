import { MOBILE_TRANSPORT_VERSION, serializeMobilePairingLink } from '@caxri/mobile-transport';
import { describe, expect, it } from 'vitest';

import { pairingLinkFromRouteParameters } from '../pairing-link-route';

const pairingLink = serializeMobilePairingLink({
    addresses: ['192.168.1.3'],
    expiresAt: 2_000_000_000_000,
    pairingId: '12'.repeat(16),
    port: 4_321,
    secret: '34'.repeat(32),
    serverId: 'server_test',
    version: MOBILE_TRANSPORT_VERSION,
});

const routeParameters = Object.fromEntries(new URL(pairingLink).searchParams);

describe('pairingLinkFromRouteParameters', () => {
    it('reconstructs the desktop pairing link from the /pair route', () => {
        expect(pairingLinkFromRouteParameters(routeParameters)).toBe(pairingLink);
    });

    it.each([
        { ...routeParameters, secret: undefined },
        { ...routeParameters, secret: [routeParameters.secret] },
        { ...routeParameters, unexpected: 'value' },
    ])('rejects an incomplete, repeated, or extended route contract', (parameters) => {
        expect(() => pairingLinkFromRouteParameters(parameters)).toThrow(
            'Pairing route parameters do not match the protocol',
        );
    });
});
