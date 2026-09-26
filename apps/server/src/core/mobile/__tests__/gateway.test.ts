import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HandshakeTranscript } from '@caxri/mobile-transport';
import {
    decodeHex,
    deriveMobileSessionKeys,
    encodeHex,
    handshakeConfirmation,
    isHandshakeConfirmationValid,
    MOBILE_TRANSPORT_VERSION,
    mobileClientConfirmationSchema,
    mobilePairingResultSchema,
    mobilePublicKey,
    mobileRevokedSchema,
    mobileSealedFrameSchema,
    mobileServerHelloSchema,
    mobileVersionMismatchSchema,
    openMobileFrame,
    parseMobilePairingLink,
    sealMobileFrame,
} from '@caxri/mobile-transport';
import type { CommandAdapter, Principal } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileDeviceRegistry } from '../device-registry';
import { MobileGateway, selectMobileGatewayAddress } from '../gateway';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { connectDevice, nextMessage, openSocket } from './gateway-client.fixture';

const temporaryDirectories: string[] = [];

async function registryFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-gateway-'));
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

describe('MobileGateway', () => {
    it('records bounded transport causes without peer or payload contents', async () => {
        const registry = await registryFixture();
        const write = vi.fn();
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: {
                server: {
                    invoke: () => {
                        throw new Error('Unexpected dispatch');
                    },
                },
            },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            logger: { write },
            selectAddress: () => '127.0.0.1',
        });
        const enabled = await gateway.enable();
        try {
            await Promise.all(
                [false, false, true].map(async (binary) => {
                    const socket = await openSocket(
                        `ws://${enabled.address}:${enabled.port}/mobile`,
                    );
                    const closed = new Promise<void>((resolve) => {
                        socket.once('close', () => resolve());
                    });
                    socket.send('private-fixture-payload', { binary });
                    await closed;
                }),
            );
        } finally {
            await gateway.close();
        }
        expect(write).toHaveBeenCalledWith('warn', 'mobile_gateway.failure', {
            fields: { reason: 'invalidHandshake' },
        });
        expect(write).toHaveBeenCalledWith('warn', 'mobile_gateway.failure', {
            fields: { reason: 'binaryFrame' },
        });
        expect(write.mock.calls.at(-1)).toMatchObject([
            'info',
            'mobile_gateway.failure_summary',
            {
                fields: { invalidHandshake: 2, binaryFrame: 1, total: 3 },
            },
        ]);
        expect(write).toHaveBeenCalledTimes(3);
        expect(JSON.stringify(write.mock.calls)).not.toMatch(
            /private-fixture-payload|127\.0\.0\.1/u,
        );
    });

    it.each(['view', 'reply', 'control'] as const)(
        'enforces the %s role on each encrypted request and rejects a revoked generation',
        async (role) => {
            const registry = await registryFixture();
            const record = {
                ...registry.preparePair({
                    displayName: 'Test tablet',
                    platform: 'android',
                    projectIds: ['project-1'],
                }),
                role,
            };
            await registry.commitPair(record);
            const invoke = vi.fn<CommandAdapter['invoke']>((request) => {
                switch (request.method) {
                    case 'mobile.dashboard':
                        return {
                            hostDisplayName: 'Test computer',
                            deviceRole: role,
                            projects: [{ id: 'project-1', displayTitle: 'Test Project' }],
                            sessions: [],
                            total: 0,
                            truncated: false,
                        };
                    case 'mobile.agent.submit':
                        return {
                            terminalId: 'terminal-1',
                            outcome: 'accepted',
                        };
                    case 'mobile.session.create':
                        return { sessionId: 'session-new' };
                    default:
                        throw new Error('Unexpected gateway method');
                }
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
            expect(gateway.hasAttentionRecipient('project-1')).toBe(role === 'control');
            expect(gateway.hasAttentionRecipient('another-project')).toBe(false);
            const request = (id: string, method: string, parameters: unknown) => ({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id,
                method,
                params: parameters,
            });
            try {
                await expect(
                    client.request(request('dashboard', 'mobile.dashboard', {})),
                ).resolves.toMatchObject({ ok: true });
                await expect(
                    client.request(
                        request('reply', 'mobile.agent.submit', {
                            sessionId: 'session-1',
                            terminalId: 'terminal-1',
                            endpoint: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                            clientMutationId: 'mutation-1',
                            text: 'Hi',
                        }),
                    ),
                ).resolves.toMatchObject({
                    ok: role !== 'view',
                    ...(role === 'view' && { error: { code: 'FORBIDDEN' } }),
                });
                await expect(
                    client.request(
                        request('create', 'mobile.session.create', {
                            projectId: 'project-1',
                            defaultAgent: 'codex',
                        }),
                    ),
                ).resolves.toMatchObject({
                    ok: role === 'control',
                    ...(role !== 'control' && { error: { code: 'FORBIDDEN' } }),
                });
                expect(invoke).toHaveBeenCalledTimes(
                    role === 'view' ? 1 : role === 'reply' ? 2 : 3,
                );

                const closed = new Promise<number>((resolve) =>
                    client.socket.once('close', resolve),
                );
                await registry.revoke(record.deviceId, record.generation);
                expect(gateway.hasAttentionRecipient('project-1')).toBe(false);
                client.send({
                    type: 'request',
                    request: request('after-revoke', 'mobile.dashboard', {}),
                });
                await expect(closed).resolves.toBe(1_006);
                expect(invoke).toHaveBeenCalledTimes(
                    role === 'view' ? 1 : role === 'reply' ? 2 : 3,
                );
            } finally {
                client.socket.close();
                await gateway.close();
            }
        },
    );

    it('selects only a private non-loopback IPv4 interface', () => {
        expect(
            selectMobileGatewayAddress({
                lo0: [
                    {
                        address: '127.0.0.1',
                        netmask: '255.0.0.0',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:00',
                        internal: true,
                        cidr: '127.0.0.1/8',
                    },
                ],
                en0: [
                    {
                        address: '192.168.1.5',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:01',
                        internal: false,
                        cidr: '192.168.1.5/24',
                    },
                ],
            }),
        ).toBe('192.168.1.5');
        expect(() =>
            selectMobileGatewayAddress({
                en0: [
                    {
                        address: '203.0.113.8',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:01',
                        internal: false,
                        cidr: '203.0.113.8/24',
                    },
                ],
            }),
        ).toThrow('No private IPv4 network');
    });

    it('prefers a physical macOS interface over a lexically earlier VPN address', () => {
        expect(
            selectMobileGatewayAddress({
                utun4: [
                    {
                        address: '10.0.0.2',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:02',
                        internal: false,
                        cidr: '10.0.0.2/24',
                    },
                ],
                en0: [
                    {
                        address: '192.168.1.5',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:01',
                        internal: false,
                        cidr: '192.168.1.5/24',
                    },
                ],
            }),
        ).toBe('192.168.1.5');
    });

    it('advertises a Tailscale address before a physical LAN address', () => {
        expect(
            selectMobileGatewayAddress({
                en0: [
                    {
                        address: '192.168.1.5',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:01',
                        internal: false,
                        cidr: '192.168.1.5/24',
                    },
                ],
                utun4: [
                    {
                        address: '100.100.100.1',
                        netmask: '255.192.0.0',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:02',
                        internal: false,
                        cidr: '100.100.100.1/10',
                    },
                ],
            }),
        ).toBe('100.100.100.1');
    });

    it.each(['pair', 'connect'] as const)(
        'returns an explicit version mismatch before %s authentication',
        async (mode) => {
            const registry = await registryFixture();
            const gateway = new MobileGateway({
                ...subscriptionOptions,
                adapters: { server: { invoke: vi.fn() } },
                authorizePairedDeviceMethod: authorizeMethod,
                bootId: 'b'.repeat(32),
                protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
                registry,
                selectAddress: () => '127.0.0.1',
            });
            const enabled = await gateway.enable();
            const pairing = gateway.createPairing(['project-1']);
            const link = parseMobilePairingLink(pairing.pairingLink);
            const socket = await openSocket(`ws://${enabled.address}:${enabled.port}/mobile`);
            try {
                const reply = nextMessage(socket);
                socket.send(
                    JSON.stringify({
                        type: 'hello',
                        version: MOBILE_TRANSPORT_VERSION + 1,
                        mode,
                        ...(mode === 'pair'
                            ? { pairingId: link.pairingId }
                            : { deviceId: `device_${'11'.repeat(16)}`, generation: 1 }),
                    }),
                );
                expect(mobileVersionMismatchSchema.parse(await reply)).toEqual({
                    type: 'version-mismatch',
                    supportedVersion: MOBILE_TRANSPORT_VERSION,
                });
                expect(gateway.status().pendingPairingCount).toBe(1);
            } finally {
                socket.close();
                await gateway.close();
            }
        },
    );

    it('consumes a pairing ID on the first hello and rejects a second handshake', async () => {
        const registry = await registryFixture();
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
        });
        const enabled = await gateway.enable();
        const link = parseMobilePairingLink(gateway.createPairing(['project-1']).pairingLink);
        const clientSecret = decodeHex('21'.repeat(32));
        const clientPublicKey = mobilePublicKey(clientSecret);
        const clientNonce = decodeHex('31'.repeat(32));
        const hello = {
            type: 'hello',
            version: MOBILE_TRANSPORT_VERSION,
            mode: 'pair',
            pairingId: link.pairingId,
            displayName: 'Test tablet',
            platform: 'android',
            clientPublicKey: encodeHex(clientPublicKey),
            clientNonce: encodeHex(clientNonce),
        };
        const url = `ws://${enabled.address}:${enabled.port}/mobile`;
        const first = await openSocket(url);
        const second = await openSocket(url);
        try {
            const firstMessage = nextMessage(first);
            first.send(JSON.stringify(hello));
            mobileServerHelloSchema.parse(await firstMessage);
            expect(gateway.status().pendingPairingCount).toBe(0);

            const secondMessage = nextMessage(second);
            second.send(JSON.stringify(hello));
            const challenge = mobileServerHelloSchema.parse(await secondMessage);
            const transcript: HandshakeTranscript = {
                mode: 'pair',
                serverId: link.serverId,
                principalId: `paired-device:${challenge.deviceId}`,
                connectionId: decodeHex(challenge.connectionId, 16),
                clientPublicKey,
                serverPublicKey: decodeHex(challenge.serverPublicKey, 32),
                clientNonce,
                serverNonce: decodeHex(challenge.serverNonce, 32),
            };
            const keys = deriveMobileSessionKeys({
                localSecretKey: clientSecret,
                peerPublicKey: transcript.serverPublicKey,
                presharedKey: decodeHex(link.secret, 32),
                transcript,
            });
            expect(
                isHandshakeConfirmationValid(decodeHex(challenge.confirmation, 32), keys, 'server'),
            ).toBe(false);
        } finally {
            first.close();
            second.close();
            await gateway.close();
        }
    });

    it('reuses the persisted endpoint port after mobile access is toggled', async () => {
        const registry = await registryFixture();
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
        });
        const first = await gateway.enable();
        await gateway.disable();
        const second = await gateway.enable();
        expect(second.port).toBe(first.port);
        await gateway.close();
    });

    it('owns and closes a pre-upgrade TCP connection when mobile access is disabled', async () => {
        const registry = await registryFixture();
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            selectAddress: () => '127.0.0.1',
        });
        const enabled = await gateway.enable();
        if (!enabled.port) throw new Error('Mobile gateway did not publish a port');
        const socket = createConnection({ host: '127.0.0.1', port: enabled.port });
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));

        await gateway.disable();

        await closed;
    });

    it.each([
        { credential: 'wrong' as const, revokeBeforeConnect: false },
        { credential: 'stored' as const, revokeBeforeConnect: true },
    ])(
        'keeps $credential credentials indistinguishable after revoke=$revokeBeforeConnect',
        async ({ credential, revokeBeforeConnect }) => {
            const registry = await registryFixture();
            const paired = await registry.pair({
                displayName: 'Credential test tablet',
                platform: 'android',
                projectIds: ['project-1'],
            });
            if (revokeBeforeConnect)
                await registry.revoke(paired.device.deviceId, paired.device.generation);
            let gatewayByte = 100;
            const gateway = new MobileGateway({
                ...subscriptionOptions,
                adapters: { server: { invoke: vi.fn() } },
                authorizePairedDeviceMethod: authorizeMethod,
                bootId: 'b'.repeat(32),
                protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
                random: (bytes) => new Uint8Array(bytes).fill(gatewayByte++),
                registry,
                selectAddress: () => '127.0.0.1',
            });
            const enabled = await gateway.enable();
            const socket = await openSocket(`ws://${enabled.address}:${enabled.port}/mobile`, {
                origin: `http://${enabled.address}:${enabled.port}`,
            });
            try {
                const clientSecret = decodeHex('41'.repeat(32));
                const clientPublicKey = mobilePublicKey(clientSecret);
                const clientNonce = decodeHex('51'.repeat(32));
                const challengeMessage = nextMessage(socket);
                socket.send(
                    JSON.stringify({
                        type: 'hello',
                        version: MOBILE_TRANSPORT_VERSION,
                        mode: 'connect',
                        deviceId: paired.device.deviceId,
                        generation: paired.device.generation,
                        clientPublicKey: encodeHex(clientPublicKey),
                        clientNonce: encodeHex(clientNonce),
                    }),
                );
                const challenge = mobileServerHelloSchema.parse(await challengeMessage);
                const transcript: HandshakeTranscript = {
                    mode: 'connect',
                    serverId: 'a'.repeat(32),
                    principalId: `paired-device:${paired.device.deviceId}`,
                    connectionId: decodeHex(challenge.connectionId, 16),
                    clientPublicKey,
                    serverPublicKey: decodeHex(challenge.serverPublicKey, 32),
                    clientNonce,
                    serverNonce: decodeHex(challenge.serverNonce, 32),
                };
                const clientKeys = deriveMobileSessionKeys({
                    localSecretKey: clientSecret,
                    peerPublicKey: transcript.serverPublicKey,
                    presharedKey: decodeHex(
                        credential === 'stored' ? paired.credential : 'ff'.repeat(32),
                    ),
                    transcript,
                });
                expect(
                    isHandshakeConfirmationValid(
                        decodeHex(challenge.confirmation, 32),
                        clientKeys,
                        'server',
                    ),
                ).toBe(false);

                const closedWithoutReady = new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(
                        () => reject(new Error('Rejected connection stayed open')),
                        1_000,
                    );
                    socket.once('message', () => {
                        clearTimeout(timer);
                        reject(new Error('Rejected connection received a ready frame'));
                    });
                    socket.once('close', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
                const clientConfirmation = mobileClientConfirmationSchema.parse({
                    type: 'confirm',
                    version: MOBILE_TRANSPORT_VERSION,
                    connectionId: challenge.connectionId,
                    confirmation: encodeHex(handshakeConfirmation(clientKeys, 'client')),
                });
                socket.send(JSON.stringify(clientConfirmation));
                await expect(closedWithoutReady).resolves.toBeUndefined();
            } finally {
                socket.close();
                await gateway.close();
            }
        },
    );

    it('pairs and authenticates a Tailscale source, rejects forbidden methods, and revokes the live generation', async () => {
        const registry = await registryFixture();
        const sourceAddress = vi.fn(() => '100.100.100.1');
        const invoke = vi.fn<CommandAdapter['invoke']>((request) => {
            if (request.method !== 'mobile.dashboard')
                throw new Error('Unexpected allowed request');
            return {
                hostDisplayName: 'Test computer',
                deviceRole: 'control',
                projects: [{ id: 'project-1', displayTitle: 'Test Project' }],
                sessions: [],
                total: 0,
                truncated: false,
            };
        });
        let gatewayByte = 100;
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            random: (bytes) => new Uint8Array(bytes).fill(gatewayByte++),
            registry,
            selectAddress: () => '127.0.0.1',
            sourceAddress,
        });
        expect(gateway.status()).toMatchObject({ enabled: false, pendingPairingCount: 0 });
        const enabled = await gateway.enable();
        const pairing = gateway.createPairing(['project-1']);
        const link = parseMobilePairingLink(pairing.pairingLink);
        const gatewayUrl = `ws://${enabled.address}:${enabled.port}/mobile`;
        await expect(openSocket(gatewayUrl, { origin: 'https://example.com' })).rejects.toThrow();
        const socket = await openSocket(gatewayUrl, {
            origin: `http://${enabled.address}:${enabled.port}`,
        });
        expect(sourceAddress).toHaveBeenCalled();

        const clientSecret = decodeHex('21'.repeat(32));
        const clientPublicKey = mobilePublicKey(clientSecret);
        const clientNonce = decodeHex('31'.repeat(32));
        const challengeMessage = nextMessage(socket);
        socket.send(
            JSON.stringify({
                type: 'hello',
                version: MOBILE_TRANSPORT_VERSION,
                mode: 'pair',
                pairingId: link.pairingId,
                displayName: 'Test tablet',
                platform: 'android',
                clientPublicKey: encodeHex(clientPublicKey),
                clientNonce: encodeHex(clientNonce),
            }),
        );
        const challenge = mobileServerHelloSchema.parse(await challengeMessage);
        const transcript: HandshakeTranscript = {
            mode: 'pair',
            serverId: link.serverId,
            principalId: `paired-device:${challenge.deviceId}`,
            connectionId: decodeHex(challenge.connectionId, 16),
            clientPublicKey,
            serverPublicKey: decodeHex(challenge.serverPublicKey, 32),
            clientNonce,
            serverNonce: decodeHex(challenge.serverNonce, 32),
        };
        const keys = deriveMobileSessionKeys({
            localSecretKey: clientSecret,
            peerPublicKey: transcript.serverPublicKey,
            presharedKey: decodeHex(link.secret, 32),
            transcript,
        });
        const serverConfirmation = decodeHex(challenge.confirmation, 32);
        expect(isHandshakeConfirmationValid(serverConfirmation, keys, 'server')).toBe(true);

        const pairedFrameMessage = nextMessage(socket);
        const clientConfirmation = handshakeConfirmation(keys, 'client');
        const confirmationFrame = mobileClientConfirmationSchema.parse({
            type: 'confirm',
            version: MOBILE_TRANSPORT_VERSION,
            connectionId: challenge.connectionId,
            confirmation: encodeHex(clientConfirmation),
        });
        socket.send(JSON.stringify(confirmationFrame));
        const pairedFrame = mobileSealedFrameSchema.parse(await pairedFrameMessage);
        const pairedPlaintext = openMobileFrame(
            keys.serverToClient,
            {
                connectionId: transcript.connectionId,
                counter: pairedFrame.counter,
                deviceId: challenge.deviceId,
                direction: 'server-to-client',
            },
            decodeHex(pairedFrame.ciphertext),
        );
        const pairedSource = new TextDecoder().decode(pairedPlaintext);
        const paired = mobilePairingResultSchema.parse(JSON.parse(pairedSource));
        expect(paired).toMatchObject({ deviceId: challenge.deviceId, projectIds: ['project-1'] });

        const sendRequest = async (counter: number, request: unknown) => {
            const replyMessage = nextMessage(socket);
            const requestSource = JSON.stringify({ type: 'request', request });
            const requestPlaintext = new TextEncoder().encode(requestSource);
            const requestCiphertext = sealMobileFrame(
                keys.clientToServer,
                {
                    connectionId: transcript.connectionId,
                    counter,
                    deviceId: paired.deviceId,
                    direction: 'client-to-server',
                },
                requestPlaintext,
            );
            const requestFrame = {
                type: 'sealed',
                version: MOBILE_TRANSPORT_VERSION,
                connectionId: challenge.connectionId,
                counter,
                ciphertext: encodeHex(requestCiphertext),
            };
            socket.send(JSON.stringify(requestFrame));
            const frame = mobileSealedFrameSchema.parse(await replyMessage);
            const replyPlaintext = openMobileFrame(
                keys.serverToClient,
                {
                    connectionId: transcript.connectionId,
                    counter: frame.counter,
                    deviceId: paired.deviceId,
                    direction: 'server-to-client',
                },
                decodeHex(frame.ciphertext),
            );
            const replySource = new TextDecoder().decode(replyPlaintext);
            const payload = JSON.parse(replySource) as { type: string; reply: unknown };
            expect(payload.type).toBe('reply');
            return payload.reply;
        };

        await expect(
            sendRequest(0, {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'forbidden-1',
                method: 'settings.inspect',
                params: {},
            }),
        ).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
        await expect(
            sendRequest(1, {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'allowed-1',
                method: 'mobile.dashboard',
                params: {},
            }),
        ).resolves.toMatchObject({
            ok: true,
            result: {
                hostDisplayName: 'Test computer',
                projects: [{ id: 'project-1', displayTitle: 'Test Project' }],
                sessions: [],
                total: 0,
                truncated: false,
            },
        });
        expect(invoke).toHaveBeenCalledOnce();

        const revokedMessage = nextMessage(socket);
        const closed = new Promise<number>((resolve) =>
            socket.once('close', (code) => resolve(code)),
        );
        await gateway.revoke(paired.deviceId, paired.generation);
        const revokedFrame = mobileSealedFrameSchema.parse(await revokedMessage);
        const revokedPlaintext = openMobileFrame(
            keys.serverToClient,
            {
                connectionId: transcript.connectionId,
                counter: revokedFrame.counter,
                deviceId: paired.deviceId,
                direction: 'server-to-client',
            },
            decodeHex(revokedFrame.ciphertext),
        );
        const revokedSource = new TextDecoder().decode(revokedPlaintext);
        const revokedPayload = mobileRevokedSchema.parse(JSON.parse(revokedSource));
        expect(revokedPayload).toEqual({
            type: 'revoked',
            deviceId: paired.deviceId,
            generation: paired.generation,
        });
        await expect(closed).resolves.toBe(1_000);
        expect(() => registry.currentPrincipal(paired.deviceId, paired.generation)).toThrow(
            'Paired device authorization is unavailable',
        );
        await gateway.close();
    });
});
