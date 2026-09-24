import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandAdapter, Principal } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMobileGatewayMethodAllowedForRole } from '../access-controller';
import { MobileDeviceRegistry } from '../device-registry';
import { MobileGateway } from '../gateway';
import { connectDevice } from './gateway-client.fixture';

const temporaryDirectories: string[] = [];

async function registryFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-gateway-subscription-'));
    temporaryDirectories.push(directory);
    let byte = 1;
    return MobileDeviceRegistry.open({
        directory,
        path: join(directory, 'mobile-devices.json'),
        now: () => 1_788_106_000_000 + byte,
        random: (bytes) => new Uint8Array(bytes).fill(byte++),
    });
}

function authorizeMethod(principal: Principal, method: string): void {
    if (
        principal.kind !== 'paired-device' ||
        !isMobileGatewayMethodAllowedForRole(principal.role, method)
    )
        throw new CaxriError('FORBIDDEN', 'Paired device role does not allow this method');
}

const subscriptionOptions = {
    authorizeSubscription: () => Promise.resolve(),
    matchesSubscriptionEvent: () => Promise.resolve(true),
};

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('MobileGateway subscriptions', () => {
    it('routes subscriptions, live dashboard hints, and heartbeat over one encrypted socket', async () => {
        const registry = await registryFixture();
        const record = registry.preparePair({
            displayName: 'Test tablet',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.commitPair(record);
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            authorizeSubscription: (_principal, resource) => {
                if (resource.kind === 'terminal')
                    return Promise.reject(
                        new CaxriError('FORBIDDEN', 'Terminal is outside this Project grant'),
                    );
                return Promise.resolve();
            },
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
        });
        const client = await connectDevice(gateway, record);
        try {
            const subscribeReply = client.read();
            client.send({ type: 'subscribe', id: 'sub-1', resource: { kind: 'dashboard' } });
            const subscriptionId = (
                (await subscribeReply) as {
                    reply: { result: { subscriptionId: string } };
                }
            ).reply.result.subscriptionId;
            expect(subscriptionId).toMatch(/^[\da-f]{32}$/);

            const event = client.read();
            gateway.publish({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            });
            await expect(event).resolves.toEqual({
                type: 'event',
                subscriptionId,
                sequence: 0,
                kind: 'dashboard.changed',
            });

            const heartbeatAck = client.read();
            client.send({ type: 'heartbeat', nonce: 'ab'.repeat(16) });
            await expect(heartbeatAck).resolves.toEqual({
                type: 'heartbeat-ack',
                nonce: 'ab'.repeat(16),
            });

            const unsubscribeReply = client.read();
            client.send({ type: 'unsubscribe', id: 'unsub-1', subscriptionId });
            await expect(unsubscribeReply).resolves.toMatchObject({
                type: 'reply',
                reply: { id: 'unsub-1', ok: true, result: {} },
            });

            const rejectedSubscribe = client.read();
            client.send({
                type: 'subscribe',
                id: 'sub-denied',
                resource: { kind: 'terminal', terminalId: 'terminal-outside-grant' },
            });
            await expect(rejectedSubscribe).resolves.toMatchObject({
                type: 'reply',
                reply: { id: 'sub-denied', ok: false, error: { code: 'FORBIDDEN' } },
            });

            const activeSubscribe = client.read();
            client.send({ type: 'subscribe', id: 'sub-live', resource: { kind: 'dashboard' } });
            await expect(activeSubscribe).resolves.toMatchObject({
                type: 'reply',
                reply: { id: 'sub-live', ok: true },
            });
            const revoked = client.read();
            const closed = new Promise<number>((resolve) => client.socket.once('close', resolve));
            await gateway.revoke(record.deviceId, record.generation);
            await expect(revoked).resolves.toMatchObject({ type: 'revoked' });
            await expect(closed).resolves.toBe(1_000);
        } finally {
            client.socket.close();
            await gateway.close();
        }
    });

    it('lets heartbeat and a fast command complete while another command is pending', async () => {
        const registry = await registryFixture();
        const record = registry.preparePair({
            displayName: 'Test tablet',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.commitPair(record);
        const slowStarted = Promise.withResolvers<void>();
        const releaseSlow = Promise.withResolvers<unknown>();
        let invocationCount = 0;
        const invoke = vi.fn<CommandAdapter['invoke']>((request) => {
            if (request.method !== 'mobile.dashboard') throw new Error('Unexpected method');
            if (invocationCount++ === 0) {
                slowStarted.resolve();
                return releaseSlow.promise;
            }
            return {
                hostDisplayName: 'Test computer',
                projects: [],
                sessions: [],
                total: 0,
                truncated: false,
            };
        });
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
        });
        const client = await connectDevice(gateway, record);
        const request = (id: string) => ({
            type: 'request',
            request: {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id,
                method: 'mobile.dashboard',
                params: {},
            },
        });
        try {
            client.send(request('slow'));
            await slowStarted.promise;
            const heartbeatAck = client.read();
            client.send({ type: 'heartbeat', nonce: 'cd'.repeat(16) });
            await expect(heartbeatAck).resolves.toMatchObject({ type: 'heartbeat-ack' });
            const fastReply = client.read();
            client.send(request('fast'));
            await expect(fastReply).resolves.toMatchObject({
                type: 'reply',
                reply: { id: 'fast', ok: true },
            });
            const slowReply = client.read();
            releaseSlow.resolve({
                hostDisplayName: 'Test computer',
                projects: [],
                sessions: [],
                total: 0,
                truncated: false,
            });
            await expect(slowReply).resolves.toMatchObject({
                type: 'reply',
                reply: { id: 'slow', ok: true },
            });
        } finally {
            releaseSlow.resolve(undefined);
            client.socket.close();
            await gateway.close();
        }
    });

    it('can publish an authenticated event before the subscription acknowledgement', async () => {
        const registry = await registryFixture();
        const record = registry.preparePair({
            displayName: 'Test tablet',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.commitPair(record);
        const secondAuthorization = Promise.withResolvers<void>();
        const releaseAuthorization = Promise.withResolvers<void>();
        let authorizationCount = 0;
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            authorizeSubscription: async () => {
                if (++authorizationCount !== 2) {
                    return;
                }

                secondAuthorization.resolve();
                await releaseAuthorization.promise;
            },
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
        });
        const client = await connectDevice(gateway, record);
        try {
            client.send({ type: 'subscribe', id: 'sub-early', resource: { kind: 'dashboard' } });
            await secondAuthorization.promise;
            const earlyEvent = client.read();
            gateway.publish({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            });
            await expect(earlyEvent).resolves.toMatchObject({
                type: 'event',
                sequence: 0,
                kind: 'dashboard.changed',
            });
            const acknowledgement = client.read();
            releaseAuthorization.resolve();
            await expect(acknowledgement).resolves.toMatchObject({
                type: 'reply',
                reply: { id: 'sub-early', ok: true },
            });
        } finally {
            releaseAuthorization.resolve();
            client.socket.close();
            await gateway.close();
        }
    });
});
