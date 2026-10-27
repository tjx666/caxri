// oxlint-disable typescript/require-await, typescript/unbound-method -- Async Host fakes and Vitest method assertions have no this binding.

import type { CommandAdapter, Principal } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort, TerminalObserverEvent } from '../../../domains/terminal';
import { createMemoryMobileDeviceStore } from '../../__tests__/credential-stores.fixture';
import { MobileDeviceRegistry } from '../device-registry';
import { MobileGateway } from '../gateway';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { connectDevice } from './gateway-client.fixture';

function registryFixture() {
    let byte = 1;
    return MobileDeviceRegistry.open({
        store: createMemoryMobileDeviceStore(),
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

describe('MobileGateway subscriptions', () => {
    it('aborts queued Terminal input as soon as revocation begins, before registry persistence', async () => {
        const registry = registryFixture();
        const record = registry.preparePair({
            displayName: 'Test tablet',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.commitPair(record);
        const queued = Promise.withResolvers<AbortSignal>();
        const releaseHost = Promise.withResolvers<void>();
        const durableStarted = Promise.withResolvers<void>();
        const releaseDurable = Promise.withResolvers<void>();
        const originalRevoke = registry.revoke.bind(registry);
        vi.spyOn(registry, 'revoke').mockImplementation(async (...arguments_) => {
            durableStarted.resolve();
            await releaseDurable.promise;
            return originalRevoke(...arguments_);
        });
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, generation: 1, nextSequence: 0 })),
            unobserve: vi.fn(async () => {}),
            onObserverEvent: vi.fn(() => () => {}),
            onHostExit: vi.fn(() => () => {}),
            inputForGeneration: vi.fn(
                async (
                    _terminalId: string,
                    _generation: number,
                    _data: string,
                    signal: AbortSignal,
                ) => {
                    queued.resolve(signal);
                    await releaseHost.promise;
                    if (signal.aborted) throw new Error('Canceled before Host send');
                    return true;
                },
            ),
        } as unknown as TerminalExecutionPort;
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
            terminalExecution: port,
        });
        const client = await connectDevice(gateway, record);
        try {
            const ack = client.read();
            client.send({
                type: 'subscribe',
                id: 'sub-input',
                resource: { kind: 'terminal', terminalId: 'terminal-1' },
            });
            const subscriptionId = (
                (await ack) as { reply: { result: { subscriptionId: string } } }
            ).reply.result.subscriptionId;
            await client.read();
            const observer = gateway.terminalSubscription(
                {
                    capabilities: [],
                    principal: registry.currentPrincipal(record.deviceId, record.generation),
                    connection: {
                        serverId: 'a'.repeat(32),
                        bootId: 'b'.repeat(32),
                        stateEpoch: 'c'.repeat(32),
                        clientId: `mobile:${record.deviceId}`,
                        connectionId: client.connectionId,
                    },
                },
                subscriptionId,
                'terminal-1',
            );
            const input = observer.input(1, 'a');
            const signal = await queued.promise;
            expect(signal.aborted).toBe(false);
            const finalFrame = client.read();
            const revocation = gateway.revoke(record.deviceId, record.generation);
            await durableStarted.promise;
            expect(signal.aborted).toBe(true);
            releaseHost.resolve();
            await expect(input).rejects.toThrow('Canceled before Host send');
            releaseDurable.resolve();
            await revocation;
            await expect(finalFrame).resolves.toMatchObject({ type: 'revoked' });
        } finally {
            releaseHost.resolve();
            releaseDurable.resolve();
            client.socket.close();
            await gateway.close();
        }
    });

    it('resyncs a view-only Terminal observer when its Host exits without input or a lease', async () => {
        const registry = registryFixture();
        const candidate = registry.preparePair({
            displayName: 'Test tablet',
            platform: 'android',
            projectIds: ['project-1'],
        });
        const record = { ...candidate, role: 'view' as const };
        await registry.commitPair(record);
        let hostExit: ((terminalIds: readonly string[]) => void) | undefined;
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, generation: 1, nextSequence: 0 })),
            unobserve: vi.fn(async () => {}),
            onObserverEvent: vi.fn(() => () => {}),
            onHostExit: vi.fn((listener: (terminalIds: readonly string[]) => void) => {
                hostExit = listener;
                return () => {
                    hostExit = undefined;
                };
            }),
        } as unknown as TerminalExecutionPort;
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
            terminalExecution: port,
        });
        const client = await connectDevice(gateway, record);
        try {
            const ack = client.read();
            client.send({
                type: 'subscribe',
                id: 'sub-view',
                resource: { kind: 'terminal', terminalId: 'terminal-1' },
            });
            const subscriptionId = (
                (await ack) as { reply: { result: { subscriptionId: string } } }
            ).reply.result.subscriptionId;
            await expect(client.read()).resolves.toMatchObject({ kind: 'terminal.snapshot' });
            const resync = client.read();
            hostExit?.(['terminal-1']);
            await expect(resync).resolves.toMatchObject({
                type: 'event',
                kind: 'resync-required',
                reason: 'generation-changed',
                subscriptionId,
                sequence: 1,
            });
            await vi.waitFor(() =>
                expect(port.unobserve).toHaveBeenCalledWith(
                    'terminal-1',
                    `${client.connectionId}:${subscriptionId}`,
                ),
            );
        } finally {
            client.socket.close();
            await gateway.close();
        }
    });

    it('ACKs before Terminal snapshot, streams Host output, and releases only its lease on revoke', async () => {
        const registry = registryFixture();
        const record = registry.preparePair({
            displayName: 'Test tablet',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.commitPair(record);
        let observerEvent: ((event: TerminalObserverEvent) => void) | undefined;
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, generation: 2, nextSequence: 0 })),
            unobserve: vi.fn(async () => {}),
            onObserverEvent: vi.fn((listener: (event: TerminalObserverEvent) => void) => {
                observerEvent = listener;
                return () => {
                    observerEvent = undefined;
                };
            }),
            onHostExit: vi.fn(() => () => {}),
            takeOver: vi.fn(async () => ({ expiresAt: 1_788_106_012_000 })),
            renewTakeOver: vi.fn(async () => ({ expiresAt: 1_788_106_015_000 })),
            releaseTakeOver: vi.fn(async () => {}),
            attach: vi.fn(),
            resize: vi.fn(),
        } as unknown as TerminalExecutionPort;
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: {
                server: {
                    invoke: async (request, context) => {
                        if (request.method === 'mobile.terminal.takeOver')
                            return gateway
                                .terminalSubscription(
                                    context,
                                    request.params.subscriptionId,
                                    request.params.terminalId,
                                )
                                .takeOver(request.params.expectedGeneration, {
                                    cols: request.params.cols,
                                    rows: request.params.rows,
                                });
                        throw new Error('Unexpected request');
                    },
                },
            },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
            terminalExecution: port,
        });
        const client = await connectDevice(gateway, record);
        try {
            const subscribeReply = client.read();
            client.send({
                type: 'subscribe',
                id: 'sub-terminal',
                resource: { kind: 'terminal', terminalId: 'terminal-1' },
            });
            const ack = (await subscribeReply) as {
                type: string;
                reply: { result: { subscriptionId: string } };
            };
            expect(ack.type).toBe('reply');
            const subscriptionId = ack.reply.result.subscriptionId;
            const snapshot = await client.read();
            expect(snapshot).toMatchObject({
                type: 'stream',
                kind: 'terminal.snapshot',
                subscriptionId,
                sequence: 0,
                generation: 2,
                nextHostSequence: 0,
            });
            const output = client.read();
            observerEvent?.({
                type: 'output',
                terminalId: 'terminal-1',
                generation: 2,
                sequence: 0,
                data: 'ready',
            });
            await expect(output).resolves.toMatchObject({
                type: 'stream',
                kind: 'terminal.output',
                subscriptionId,
                sequence: 1,
                hostSequence: 0,
            });
            const takeOver = await client.request({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'take-over',
                method: 'mobile.terminal.takeOver',
                params: {
                    terminalId: 'terminal-1',
                    subscriptionId,
                    expectedGeneration: 2,
                    cols: 90,
                    rows: 30,
                },
            });
            expect(takeOver).toMatchObject({ ok: true, result: { expiresAt: 1_788_106_012_000 } });
            const heartbeat = client.read();
            client.send({ type: 'heartbeat', nonce: 'ab'.repeat(16) });
            await expect(heartbeat).resolves.toMatchObject({ type: 'heartbeat-ack' });
            await vi.waitFor(() =>
                expect(port.renewTakeOver).toHaveBeenCalledWith(
                    'terminal-1',
                    `${client.connectionId}:${subscriptionId}`,
                    2,
                    12_000,
                ),
            );
            const revoked = client.read();
            await gateway.revoke(record.deviceId, record.generation);
            await expect(revoked).resolves.toMatchObject({ type: 'revoked' });
            await vi.waitFor(() =>
                expect(port.releaseTakeOver).toHaveBeenCalledWith(
                    'terminal-1',
                    `${client.connectionId}:${subscriptionId}`,
                    2,
                ),
            );
            expect(port.unobserve).toHaveBeenCalledWith(
                'terminal-1',
                `${client.connectionId}:${subscriptionId}`,
            );
            expect(port.attach).not.toHaveBeenCalled();
            expect(port.resize).not.toHaveBeenCalled();
        } finally {
            client.socket.close();
            await gateway.close();
        }
    });

    it('routes subscriptions, live dashboard hints, and heartbeat over one encrypted socket', async () => {
        const registry = registryFixture();
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
        const registry = registryFixture();
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
                deviceRole: 'control',
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
                deviceRole: 'control',
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
        const registry = registryFixture();
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
