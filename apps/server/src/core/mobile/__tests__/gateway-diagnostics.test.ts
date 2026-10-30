import { createConnection } from 'node:net';

import type { HandshakeTranscript } from '@caxri/mobile-transport';
import {
    decodeHex,
    deriveMobileSessionKeys,
    encodeHex,
    handshakeConfirmation,
    MOBILE_TRANSPORT_VERSION,
    mobileClientConfirmationSchema,
    mobilePairingResultSchema,
    mobilePublicKey,
    mobileSealedFrameSchema,
    mobileServerHelloSchema,
    openMobileFrame,
    parseMobilePairingLink,
} from '@caxri/mobile-transport';
import type { CommandAdapter } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { MobileGateway } from '../gateway';
import {
    authorizeMethod,
    connectDevice,
    nextMessage,
    openSocket,
    registryFixture,
    subscriptionOptions,
} from './gateway-client.fixture';

/**
 * Structured-log coverage for the mobile gateway's diagnostics instrumentation (issue caxri#739): bounded failure
 * reasons, pairing outcomes, and connection lifecycle events. Split out of `gateway.test.ts` to keep both files under
 * the repository's `max-lines` budget.
 */
describe('MobileGateway diagnostics', () => {
    it('records exactly one handshakeTimeout failure when a socket never completes its handshake', async () => {
        const registry = registryFixture();
        const write = vi.fn();
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            logger: { write },
            selectAddress: () => '127.0.0.1',
            handshakeTimeoutMs: 25,
        });
        const enabled = await gateway.enable();
        try {
            const socket = await openSocket(`ws://${enabled.address}:${enabled.port}/mobile`);
            const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
            await closed;
        } finally {
            await gateway.close();
        }
        const handshakeTimeoutRecords = write.mock.calls.filter(
            ([, event, payload]) =>
                event === 'mobile_gateway.failure' &&
                (payload as { fields: { reason: string } }).fields.reason === 'handshakeTimeout',
        );
        expect(handshakeTimeoutRecords).toHaveLength(1);
    });

    it('records exactly one admissionRate failure once a source exhausts its connection window', async () => {
        const registry = registryFixture();
        const write = vi.fn();
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            logger: { write },
            selectAddress: () => '127.0.0.1',
            // Must satisfy `isPrivateMobileIpv4Address`; a non-IPv4 fixture value would fail
            // admission on `admissionAddress` before the rate limiter is ever reached.
            sourceAddress: () => '10.0.0.5',
        });
        const enabled = await gateway.enable();
        const { port } = enabled;
        if (!port) throw new Error('Mobile gateway did not publish a port');
        try {
            // MAXIMUM_SOURCE_ATTEMPTS is 10; the 11th connection attempt from the same source is
            // rejected. `SourceAttemptLimiter.admit` runs synchronously in the server's
            // `'connection'` handler (see gateway.ts), so firing every attempt concurrently is as
            // valid as a strict sequence and avoids an artificial `await`-in-loop.
            await Promise.all(
                Array.from({ length: 11 }, async () => {
                    const socket = createConnection({ host: '127.0.0.1', port });
                    await new Promise<void>((resolve, reject) => {
                        socket.once('connect', () => resolve());
                        socket.once('error', reject);
                    });
                    socket.destroy();
                }),
            );
            await vi.waitFor(() => {
                expect(
                    write.mock.calls.some(
                        ([, event, payload]) =>
                            event === 'mobile_gateway.failure' &&
                            (payload as { fields: { reason: string } }).fields.reason ===
                                'admissionRate',
                    ),
                ).toBe(true);
            });
        } finally {
            await gateway.close();
        }
        const admissionRateRecords = write.mock.calls.filter(
            ([, event, payload]) =>
                event === 'mobile_gateway.failure' &&
                (payload as { fields: { reason: string } }).fields.reason === 'admissionRate',
        );
        expect(admissionRateRecords).toHaveLength(1);
    });

    it('distinguishes pairing outcomes and keeps a per-lifetime count of each', async () => {
        const registry = registryFixture();
        const write = vi.fn();
        let clock = 1_000_000;
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            logger: { write },
            selectAddress: () => '127.0.0.1',
            now: () => clock,
        });
        const enabled = await gateway.enable();
        const url = `ws://${enabled.address}:${enabled.port}/mobile`;
        const ghostSecret = decodeHex('41'.repeat(32));
        const ghostNonce = decodeHex('51'.repeat(32));
        const helloBase = {
            type: 'hello',
            version: MOBILE_TRANSPORT_VERSION,
            mode: 'pair',
            displayName: 'Ghost tablet',
            platform: 'android',
            clientPublicKey: encodeHex(mobilePublicKey(ghostSecret)),
            clientNonce: encodeHex(ghostNonce),
        };
        try {
            const expiringPairing = gateway.createPairing(['project-1']);
            const expiringLink = parseMobilePairingLink(expiringPairing.pairingLink);

            const notFoundSocket = await openSocket(url);
            const notFoundChallenge = nextMessage(notFoundSocket);
            notFoundSocket.send(JSON.stringify({ ...helloBase, pairingId: 'f'.repeat(32) }));
            await notFoundChallenge;
            notFoundSocket.close();

            clock += 3 * 60_000; // Past PAIRING_TTL_MS (2 minutes), so the first pairing is now expired.
            const expiredSocket = await openSocket(url);
            const expiredChallenge = nextMessage(expiredSocket);
            expiredSocket.send(JSON.stringify({ ...helloBase, pairingId: expiringLink.pairingId }));
            await expiredChallenge;
            expiredSocket.close();

            const succeedingPairing = gateway.createPairing(['project-1']);
            const succeedingLink = parseMobilePairingLink(succeedingPairing.pairingLink);
            const clientSecret = decodeHex('21'.repeat(32));
            const clientPublicKey = mobilePublicKey(clientSecret);
            const clientNonce = decodeHex('31'.repeat(32));
            const succeedingSocket = await openSocket(url);
            const challengeMessage = nextMessage(succeedingSocket);
            succeedingSocket.send(
                JSON.stringify({
                    type: 'hello',
                    version: MOBILE_TRANSPORT_VERSION,
                    mode: 'pair',
                    pairingId: succeedingLink.pairingId,
                    displayName: 'Test tablet',
                    platform: 'android',
                    clientPublicKey: encodeHex(clientPublicKey),
                    clientNonce: encodeHex(clientNonce),
                }),
            );
            const challenge = mobileServerHelloSchema.parse(await challengeMessage);
            const transcript: HandshakeTranscript = {
                mode: 'pair',
                serverId: succeedingLink.serverId,
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
                presharedKey: decodeHex(succeedingLink.secret, 32),
                transcript,
            });
            const pairedFrameMessage = nextMessage(succeedingSocket);
            const confirmationHex = encodeHex(handshakeConfirmation(keys, 'client'));
            succeedingSocket.send(
                JSON.stringify(
                    mobileClientConfirmationSchema.parse({
                        type: 'confirm',
                        version: MOBILE_TRANSPORT_VERSION,
                        connectionId: challenge.connectionId,
                        confirmation: confirmationHex,
                    }),
                ),
            );
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
            const pairedResultSource = new TextDecoder().decode(pairedPlaintext);
            mobilePairingResultSchema.parse(JSON.parse(pairedResultSource));
            succeedingSocket.close();
        } finally {
            await gateway.close();
        }
        expect(write).toHaveBeenCalledWith('info', 'mobile_gateway.pairing_outcome', {
            fields: { reason: 'started' },
        });
        expect(write).toHaveBeenCalledWith('info', 'mobile_gateway.pairing_outcome', {
            fields: { reason: 'not-found' },
        });
        expect(write).toHaveBeenCalledWith('info', 'mobile_gateway.pairing_outcome', {
            fields: { reason: 'expired' },
        });
        expect(write).toHaveBeenCalledWith('info', 'mobile_gateway.pairing_outcome', {
            fields: { reason: 'succeeded' },
        });
        const summaryCalls = write.mock.calls.filter(
            ([, event]) => event === 'mobile_gateway.pairing_summary',
        );
        expect(summaryCalls.at(-1)?.[2]).toEqual({
            fields: { started: 2, succeeded: 1, expired: 1, notFound: 1, total: 5 },
        });
    });

    it('records connection lifecycle with an established event and a durationMs on close', async () => {
        const registry = registryFixture();
        const record = registry.preparePair({
            displayName: 'Test tablet',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.commitPair(record);
        const write = vi.fn();
        let clock = 1_000;
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            logger: { write },
            selectAddress: () => '127.0.0.1',
            now: () => clock,
        });
        try {
            const client = await connectDevice(gateway, record);
            // The fixed clock makes every handshake leg zero; the fields still name each leg.
            expect(write).toHaveBeenCalledWith('info', 'mobile_gateway.connection_established', {
                fields: {
                    deviceId: record.deviceId,
                    route: 'lan',
                    handshakeMs: 0,
                    helloWaitMs: 0,
                    confirmWaitMs: 0,
                    authMs: 0,
                },
            });
            clock = 5_000;
            const closed = new Promise<void>((resolve) =>
                client.socket.once('close', () => resolve()),
            );
            client.socket.close();
            await closed;
            // The client's `close` event fires on its own socket half; it does not guarantee the
            // server has finished its `remove()` cleanup (and the `connectionEnded` write) yet.
            await vi.waitFor(() => {
                expect(write).toHaveBeenCalledWith('info', 'mobile_gateway.connection_ended', {
                    fields: {
                        deviceId: record.deviceId,
                        durationMs: 4_000,
                        route: 'lan',
                        cause: 'peer-closed',
                        closeCode: 1_005,
                    },
                });
            });
        } finally {
            await gateway.close();
        }
    });

    it('logs a replayed frame counter as replayRejected instead of a generic invalid frame', async () => {
        const registry = registryFixture();
        const record = registry.preparePair({
            displayName: 'Test tablet',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.commitPair(record);
        const write = vi.fn();
        const invoke = vi.fn<CommandAdapter['invoke']>(() => ({
            hostDisplayName: 'Test computer',
            deviceRole: 'control',
            projects: [],
            sessions: [],
            total: 0,
            truncated: false,
        }));
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            logger: { write },
            selectAddress: () => '127.0.0.1',
        });
        try {
            const client = await connectDevice(gateway, record);
            await client.request({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'first',
                method: 'mobile.dashboard',
                params: {},
            });
            const closed = new Promise<number>((resolve) => client.socket.once('close', resolve));
            client.send(
                {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: 'replayed',
                    method: 'mobile.dashboard',
                    params: {},
                },
                0,
            );
            await closed;
        } finally {
            await gateway.close();
        }
        expect(write).toHaveBeenCalledWith('warn', 'mobile_gateway.failure', {
            fields: { reason: 'replayRejected' },
        });
    });

    it('logs exactly one enabled and one disabled event across a toggle', async () => {
        const registry = registryFixture();
        const write = vi.fn();
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: { server: { invoke: vi.fn() } },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            logger: { write },
            selectAddress: () => '127.0.0.1',
        });
        await gateway.enable();
        await gateway.disable();
        expect(write).toHaveBeenCalledWith('info', 'mobile_gateway.enabled', { fields: {} });
        expect(write).toHaveBeenCalledWith('info', 'mobile_gateway.disabled', { fields: {} });
        expect(
            write.mock.calls.filter(([, event]) => event === 'mobile_gateway.enabled'),
        ).toHaveLength(1);
        expect(
            write.mock.calls.filter(([, event]) => event === 'mobile_gateway.disabled'),
        ).toHaveLength(1);
    });

    it('keeps log fields to closed reasons, counts, durations, and identifiers, never secrets or payloads', async () => {
        const registry = registryFixture();
        const record = registry.preparePair({
            displayName: 'Secret Display Name',
            platform: 'android',
            projectIds: ['project-1'],
        });
        await registry.commitPair(record);
        const write = vi.fn();
        const gateway = new MobileGateway({
            ...subscriptionOptions,
            adapters: {
                server: {
                    invoke: () => ({
                        hostDisplayName: 'Test computer',
                        deviceRole: 'control',
                        projects: [],
                        sessions: [],
                        total: 0,
                        truncated: false,
                    }),
                },
            },
            authorizePairedDeviceMethod: authorizeMethod,
            bootId: 'b'.repeat(32),
            protocolIdentity: { serverId: 'a'.repeat(32), stateEpoch: 'c'.repeat(32) },
            registry,
            logger: { write },
            selectAddress: () => '127.0.0.1',
        });
        try {
            const client = await connectDevice(gateway, record);
            await client.request({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'r1',
                method: 'mobile.dashboard',
                params: {},
            });
        } finally {
            await gateway.close();
        }
        const allowedFieldKeys = new Set([
            'reason',
            'deviceId',
            'route',
            'durationMs',
            'dashboardReads',
            'sessionReads',
            'admissionAddress',
            'admissionCapacity',
            'admissionRate',
            'upgradeRequest',
            'upgradeCapacity',
            'handshakeTimeout',
            'authenticationFailed',
            'invalidHandshake',
            'invalidFrame',
            'replayRejected',
            'binaryFrame',
            'inboundCapacity',
            'transportError',
            'heartbeatIdle',
            'sendFailed',
            'outboundCapacity',
            'applicationClosed',
            'versionMismatch',
            'cause',
            'failureReason',
            'closeCode',
            'clientReason',
            'total',
            'capacity',
            'generationChanged',
            'sourceGap',
            'resize',
            'started',
            'succeeded',
            'expired',
            'notFound',
            'terminalId',
            'principalKind',
            'handshakeMs',
            'helloWaitMs',
            'confirmWaitMs',
            'authMs',
            'dialMs',
            'clientGraceMs',
            'clientOpenMs',
        ]);
        for (const call of write.mock.calls) {
            const fields = (call[2] as { fields: Record<string, unknown> }).fields;
            for (const [key, value] of Object.entries(fields)) {
                expect(allowedFieldKeys.has(key)).toBe(true);
                expect(['string', 'number'].includes(typeof value)).toBe(true);
            }
        }
        const logged = JSON.stringify(write.mock.calls);
        expect(logged).not.toContain(record.credential);
        expect(logged).not.toContain('Secret Display Name');
    });
});
