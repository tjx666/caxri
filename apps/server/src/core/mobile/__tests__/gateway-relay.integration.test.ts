import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { HandshakeTranscript, MobilePairingLink } from '@caxri/mobile-transport';
import {
    decodeHex,
    deriveMobileSessionKeys,
    encodeHex,
    handshakeConfirmation,
    MOBILE_TRANSPORT_VERSION,
    mobilePairingResultSchema,
    mobilePublicKey,
    mobileSealedFrameSchema,
    mobileServerHelloSchema,
    openMobileFrame,
    parseMobilePairingLink,
    RELAY_PROTOCOL_VERSION,
    relayAccessKey,
    relayClientReadySchema,
    relayCloseCodes,
    relayEndpoint,
    relayPaths,
} from '@caxri/mobile-transport';
import type { CommandAdapter } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { MobileGateway } from '../gateway';
import { messageText } from '../gateway/socket-message';
import {
    authorizeMethod,
    connectDevice,
    nextMessage,
    registryFixture,
    subscriptionOptions,
} from './gateway-client.fixture';

const relayMain = fileURLToPath(new URL('../../../../../relay/src/main.ts', import.meta.url));
/**
 * Points the suite at an already running Relay, such as the local Docker image, instead of spawning one.
 */
const externalRelayUrl = process.env.CAXRI_RELAY_TEST_URL;

interface RelayProcess {
    child: ChildProcess;
    port: number;
}

async function startRelay(port = 0): Promise<RelayProcess> {
    const child = spawn('bun', [relayMain], {
        env: { ...process.env, CAXRI_RELAY_HOST: '127.0.0.1', CAXRI_RELAY_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: child.stdout });
    const exited = (async (): Promise<never> => {
        await once(child, 'exit');
        throw new Error('Relay exited before listening');
    })();
    const listening = (async () => {
        for await (const line of lines) {
            const parsed = JSON.parse(line) as { event?: string; port?: number };
            if (parsed.event === 'relay.listening' && parsed.port) return parsed.port;
        }
        throw new Error('Relay output ended before listening');
    })();
    return { child, port: await Promise.race([listening, exited]) };
}

async function stopRelay(relay: RelayProcess): Promise<void> {
    if (relay.child.exitCode !== null) return;
    const exited = once(relay.child, 'exit');
    relay.child.kill('SIGTERM');
    await exited;
}

/**
 * Opens a phone socket through the Relay and resolves once the splice is ready, or rejects with the Relay's close code.
 */
function openRelaySocket(
    target: NonNullable<MobilePairingLink['relay']>,
    secret: string,
    purpose: 'device' | 'pairing',
): Promise<WebSocket> {
    const socket = new WebSocket(relayEndpoint(target.url, relayPaths.client));
    return new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('close', (code) => reject(Object.assign(new Error('Relay closed'), { code })));
        const accessKey = encodeHex(relayAccessKey(decodeHex(secret, 32), purpose));
        socket.once('open', () => {
            socket.send(
                JSON.stringify({
                    type: 'relay-connect',
                    version: RELAY_PROTOCOL_VERSION,
                    hostId: target.hostId,
                    accessKey,
                }),
            );
        });
        socket.once('message', (data) => {
            relayClientReadySchema.parse(JSON.parse(messageText(data)));
            socket.removeAllListeners('close');
            socket.removeAllListeners('error');
            resolve(socket);
        });
    });
}

/**
 * Completes a pair handshake on an already spliced socket and returns the device credential the Server issued.
 */
async function pairOverSocket(socket: WebSocket, link: MobilePairingLink) {
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
            displayName: 'Relay phone',
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
    const confirmation = encodeHex(handshakeConfirmation(keys, 'client'));
    const resultMessage = nextMessage(socket);
    socket.send(
        JSON.stringify({
            type: 'confirm',
            version: MOBILE_TRANSPORT_VERSION,
            connectionId: challenge.connectionId,
            confirmation,
        }),
    );
    const frame = mobileSealedFrameSchema.parse(await resultMessage);
    const plaintext = openMobileFrame(
        keys.serverToClient,
        {
            connectionId: transcript.connectionId,
            counter: frame.counter,
            deviceId: challenge.deviceId,
            direction: 'server-to-client',
        },
        decodeHex(frame.ciphertext),
    );
    return mobilePairingResultSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
}

describe('MobileGateway over a real Relay', () => {
    const cleanups: Array<() => Promise<unknown> | void> = [];
    afterEach(async () => {
        const pending = [...cleanups];
        cleanups.length = 0;
        await Promise.all(
            pending.map(async (cleanup) => {
                await cleanup();
            }),
        );
    });

    it(
        'pairs, serves, revokes, and re-registers after a Relay restart',
        { timeout: 30_000 },
        async () => {
            let relay = externalRelayUrl ? undefined : await startRelay();
            cleanups.push(() => relay && stopRelay(relay));
            const relayUrl = externalRelayUrl ?? `ws://127.0.0.1:${relay!.port}`;
            const write = vi.fn();
            const holder: { gateway?: MobileGateway } = {};
            const invoke = vi.fn<CommandAdapter['invoke']>((request, context) => {
                if (request.method === 'mobile.update.prepare') {
                    const bundle = {
                        md5: '0'.repeat(32),
                        sizeBytes: 1,
                        version: '0.0.143',
                        versionCode: 143,
                    };
                    return {
                        bundle,
                        ...holder.gateway!.prepareUpdateDownload(context, {
                            apkPath: '/unused',
                            bundle,
                        }),
                    };
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
                registry: registryFixture(),
                logger: { write },
                selectAddress: () => '127.0.0.1',
                relayTiming: { initialBackoffMs: 50, maxBackoffMs: 200 },
            });
            holder.gateway = gateway;
            cleanups.push(() => gateway.close());
            await gateway.configureRelay(relayUrl);
            await gateway.enable();
            await vi.waitFor(() => expect(gateway.status().relay?.state).toBe('online'));

            const link = parseMobilePairingLink(gateway.createPairing(['project-1']).pairingLink);
            expect(link.relay).toEqual({ url: relayUrl, hostId: gateway.status().relay!.hostId });
            const target = link.relay!;
            const pairingSocket = await openRelaySocket(target, link.secret, 'pairing');
            const paired = await pairOverSocket(pairingSocket, link);
            pairingSocket.close();
            expect(gateway.status().pendingPairingCount).toBe(0);

            const device = {
                credential: paired.credential,
                deviceId: paired.deviceId,
                generation: paired.generation,
            };
            const client = await connectDevice(gateway, device, () =>
                openRelaySocket(target, device.credential, 'device'),
            );
            const reply = (await client.request({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'dashboard',
                method: 'mobile.dashboard',
                params: {},
            })) as { ok: boolean };
            expect(reply.ok).toBe(true);
            // The gateway's HTTP endpoint is unreachable over the Relay, so the APK comes from its GitHub Release.
            const update = (await client.request({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'update',
                method: 'mobile.update.prepare',
                params: {},
            })) as { ok: boolean; result?: { url: string } };
            expect(update).toMatchObject({
                ok: true,
                result: {
                    url: 'https://github.com/tjx666/caxri/releases/download/v0.0.143/Caxri-Mobile-0.0.143-android-arm64.apk',
                },
            });
            expect(write).toHaveBeenCalledWith('info', 'mobile_gateway.connection_established', {
                fields: expect.objectContaining({
                    deviceId: device.deviceId,
                    route: 'relay',
                    dialMs: expect.any(Number) as number,
                    handshakeMs: expect.any(Number) as number,
                }) as unknown,
            });

            // The phone must read the sealed `revoked` frame before the Relay cuts the splice, or it never clears its
            // credential.
            const finalFrame = client.read();
            await gateway.revoke(device.deviceId, device.generation);
            await expect(finalFrame).resolves.toMatchObject({ type: 'revoked' });
            await vi.waitFor(async () => {
                await expect(
                    openRelaySocket(target, device.credential, 'device'),
                ).rejects.toMatchObject({ code: relayCloseCodes.unauthorized });
            });

            if (relay) {
                const { port } = relay;
                await stopRelay(relay);
                await vi.waitFor(() => expect(gateway.status().relay?.state).not.toBe('online'));
                expect(gateway.status().relay?.lastFailure).toBeDefined();
                relay = await startRelay(port);
                await vi.waitFor(() => expect(gateway.status().relay?.state).toBe('online'), {
                    timeout: 5_000,
                });
                expect(gateway.status().relay?.lastFailure).toBeUndefined();
            }

            const logged = JSON.stringify(write.mock.calls);
            expect(logged).not.toContain(relayUrl);
            expect(logged).not.toContain(device.credential);
            expect(logged).not.toContain(link.secret);
        },
    );
});
