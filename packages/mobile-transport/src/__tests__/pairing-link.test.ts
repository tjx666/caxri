import { describe, expect, it } from 'vitest';

import type { MobilePairingLink } from '../contract';
import { MOBILE_TRANSPORT_VERSION } from '../contract';
import { parseMobilePairingLink, serializeMobilePairingLink } from '../pairing-link';

const pairing: MobilePairingLink = {
    version: MOBILE_TRANSPORT_VERSION,
    addresses: ['192.168.1.3', '10.0.0.3'],
    port: 43_341,
    serverId: 'server_test',
    pairingId: '12'.repeat(16),
    secret: 'ab'.repeat(32),
    expiresAt: 1_788_104_000_000,
};

describe('mobile pairing links', () => {
    it('round-trips the closed pairing contract', () => {
        expect(parseMobilePairingLink(serializeMobilePairingLink(pairing))).toEqual(pairing);
    });

    it('round-trips a Relay fallback and requires both Relay parameters', () => {
        const relayed: MobilePairingLink = {
            ...pairing,
            relay: { url: 'wss://relay.example.com', hostId: 'cd'.repeat(16) },
        };
        const link = serializeMobilePairingLink(relayed);

        expect(parseMobilePairingLink(link)).toEqual(relayed);
        expect(() => parseMobilePairingLink(link.replace(/&relay-host=[0-9a-f]+/u, ''))).toThrow();
        expect(() =>
            parseMobilePairingLink(link.replace('wss%3A%2F%2Frelay', 'https%3A%2F%2Frelay')),
        ).toThrow();
    });

    it.each([
        'https://pair?addresses=192.168.1.3',
        `${serializeMobilePairingLink(pairing)}&unknown=value`,
        serializeMobilePairingLink(pairing).replace('192.168.1.3', 'example.com'),
        serializeMobilePairingLink(pairing).replace('192.168.1.3', '8.8.8.8'),
        serializeMobilePairingLink(pairing).replace(`secret=${pairing.secret}`, 'secret=ABC'),
    ])('rejects unsupported or ambiguous input', (source) => {
        expect(() => parseMobilePairingLink(source)).toThrow();
    });
});
