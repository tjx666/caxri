import { parseMobilePairingLink } from '@caxri/mobile-transport';
import { describe, expect, it, vi } from 'vitest';

import { MobileGateway } from '../gateway';
import { authorizeMethod, registryFixture, subscriptionOptions } from './gateway-client.fixture';

const gatewayWith = (selectAddress: () => string) =>
    new MobileGateway({
        ...subscriptionOptions,
        adapters: { server: { invoke: vi.fn() } },
        authorizePairedDeviceMethod: authorizeMethod,
        bootId: 'b'.repeat(32),
        protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
        registry: registryFixture(),
        selectAddress,
    });

describe('MobileGateway advertised addresses', () => {
    it('advertises the current address after the computer changes networks', async () => {
        let address = '127.0.0.1';
        const gateway = gatewayWith(() => address);
        try {
            const enabled = await gateway.enable();
            address = '192.168.5.5';
            expect(gateway.currentRoutes()).toEqual({
                addresses: ['192.168.5.5'],
                port: enabled.port,
            });
            address = '10.0.0.8';
            const link = parseMobilePairingLink(gateway.createPairing(['project-1']).pairingLink);
            expect(link.addresses).toEqual(['10.0.0.8']);
            expect(gateway.status().address).toBe('10.0.0.8');
        } finally {
            await gateway.close();
        }
    });

    it('keeps the last advertised address while no private network is up', async () => {
        let address: string | undefined = '192.168.5.5';
        const gateway = gatewayWith(() => {
            if (!address) throw new Error('No private IPv4 network is available');
            return address;
        });
        try {
            await gateway.enable();
            address = undefined;
            expect(gateway.currentRoutes().addresses).toEqual(['192.168.5.5']);
        } finally {
            await gateway.close();
        }
    });
});
