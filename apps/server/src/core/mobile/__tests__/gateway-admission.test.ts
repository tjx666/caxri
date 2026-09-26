import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { MobileDeviceRegistry } from '../device-registry';
import { MobileGateway } from '../gateway';

it('counts TCP connections dropped by the native connection limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-admission-'));
    const write = vi.fn();
    let source = 1;
    const gateway = new MobileGateway({
        adapters: {
            server: {
                invoke: () => {
                    throw new Error('Unexpected dispatch');
                },
            },
        },
        authorizePairedDeviceMethod: () => {
            throw new Error('Unexpected authorization');
        },
        authorizeSubscription: () => Promise.reject(new Error('Unexpected subscription')),
        matchesSubscriptionEvent: () => Promise.resolve(false),
        bootId: 'b'.repeat(32),
        protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
        registry: await MobileDeviceRegistry.open({
            directory,
            path: join(directory, 'devices.json'),
        }),
        logger: { write },
        selectAddress: () => '127.0.0.1',
        sourceAddress: () => `10.0.0.${source++}`,
    });
    const sockets: Array<ReturnType<typeof createConnection>> = [];
    try {
        const { port } = await gateway.enable();
        if (!port) throw new Error('Gateway port is unavailable');
        await Promise.all(
            Array.from({ length: 33 }, () => {
                const socket = createConnection({ host: '127.0.0.1', port });
                sockets.push(socket);
                return new Promise<void>((resolve, reject) => {
                    socket.once('connect', resolve);
                    socket.once('error', reject);
                });
            }),
        );
        await expect
            .poll(() => write.mock.calls)
            .toContainEqual([
                'warn',
                'mobile_gateway.failure',
                { fields: { reason: 'admissionCapacity' } },
            ]);
    } finally {
        for (const socket of sockets) socket.destroy();
        await gateway.close();
        await rm(directory, { recursive: true, force: true });
    }
    expect(write.mock.calls.at(-1)).toMatchObject([
        'info',
        'mobile_gateway.failure_summary',
        { fields: { admissionCapacity: 1, total: 1 } },
    ]);
});
