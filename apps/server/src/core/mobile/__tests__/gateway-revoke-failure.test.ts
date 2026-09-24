import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileDeviceRegistry } from '../device-registry';
import { MobileGateway } from '../gateway';
import { connectDevice } from './gateway-client.fixture';

vi.mock('../gateway/sealed-payload', async (importOriginal) => ({
    ...(await importOriginal()),
    sendFinalSealedPayload: () => Promise.resolve('failed'),
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('MobileGateway revocation failure', () => {
    it('force-closes a revoked socket when its final encrypted frame cannot be sent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-revoke-failure-'));
        temporaryDirectories.push(directory);
        let byte = 1;
        const registry = await MobileDeviceRegistry.open({
            directory,
            path: join(directory, 'mobile-devices.json'),
            now: () => 1_788_106_000_000 + byte,
            random: (bytes) => new Uint8Array(bytes).fill(byte++),
        });
        const record = registry.preparePair({
            displayName: 'Test tablet',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.commitPair(record);
        const gateway = new MobileGateway({
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: () => {},
            authorizeSubscription: () => Promise.resolve(),
            matchesSubscriptionEvent: () => Promise.resolve(true),
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
        });
        const client = await connectDevice(gateway, record);
        try {
            await gateway.revoke(record.deviceId, record.generation);
            await vi.waitFor(() => expect(client.socket.readyState).toBe(3), { timeout: 500 });
        } finally {
            client.socket.close();
            await gateway.close();
        }
    });
});
