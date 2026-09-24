import type { HandshakeTranscript, MobileSessionKeys } from '@caxri/mobile-transport';
import {
    decodeHex,
    deriveMobileSessionKeys,
    encodeHex,
    handshakeConfirmation,
    isHandshakeConfirmationValid,
    MOBILE_TRANSPORT_VERSION,
    mobileClientConfirmationSchema,
    mobileClientHelloSchema,
    mobilePublicKey,
    mobileSealedFrameSchema,
    openMobileFrame,
    sealMobileFrame,
    serializeMobilePairingLink,
} from '@caxri/mobile-transport';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { MobileCredential } from '../credential-store';
import { createMobileCredentialStore } from '../credential-store';
import type { MobileGatewayRuntime, MobileReconnectError } from '../mobile-gateway-client';
import { pairMobileGateway, reconnectMobileGateway } from '../mobile-gateway-client';

const serverId = 'a'.repeat(32);
const pairingSecret = '22'.repeat(32);
const connectionId = '33'.repeat(16);
const deviceId = `device_${'44'.repeat(16)}`;
const deviceCredential = '55'.repeat(32);
const serverSecret = decodeHex('66'.repeat(32));
const serverNonce = decodeHex('77'.repeat(32));
const pairingLink = serializeMobilePairingLink({
    version: MOBILE_TRANSPORT_VERSION,
    addresses: ['192.168.1.5'],
    port: 41_337,
    serverId,
    pairingId: '11'.repeat(16),
    secret: pairingSecret,
    expiresAt: Date.now() + 60_000,
});

/**
 * In-memory protocol peer: client tests exercise the real crypto and wire contract without React Native or a port.
 */
class FakeGatewaySocket extends EventTarget {
    #keys?: MobileSessionKeys;
    #shouldFailNextSealedSend = false;
    readonly #shouldDropRequests: boolean;
    readonly #shouldRevokeAfterPair: boolean;
    #serverCounter = 0;
    #transcript?: HandshakeTranscript;
    helloCount = 0;
    isClosed = false;

    constructor(shouldRevokeAfterPair = false, openDelayMs = 0, shouldDropRequests = false) {
        super();
        this.#shouldRevokeAfterPair = shouldRevokeAfterPair;
        this.#shouldDropRequests = shouldDropRequests;
        if (openDelayMs === 0) queueMicrotask(() => this.dispatchEvent(new Event('open')));
        else setTimeout(() => this.dispatchEvent(new Event('open')), openDelayMs);
    }

    #message(value: unknown): void {
        const data = JSON.stringify(value);
        queueMicrotask(() => {
            this.dispatchEvent(new MessageEvent('message', { data }));
        });
    }

    #sealed(value: unknown, key?: Uint8Array): void {
        if (!this.#keys || !this.#transcript) throw new Error('Handshake is incomplete');
        const counter = this.#serverCounter++;
        const source = JSON.stringify(value);
        const ciphertext = sealMobileFrame(
            key ?? this.#keys.serverToClient,
            {
                connectionId: this.#transcript.connectionId,
                counter,
                deviceId,
                direction: 'server-to-client',
            },
            new TextEncoder().encode(source),
        );
        this.#message({
            type: 'sealed',
            version: MOBILE_TRANSPORT_VERSION,
            connectionId,
            counter,
            ciphertext: encodeHex(ciphertext),
        });
    }

    close(): void {
        this.isClosed = true;
        this.dispatchEvent(new Event('close'));
    }

    failNextSealedSend(): void {
        this.#shouldFailNextSealedSend = true;
    }

    send(source: string): void {
        const raw = JSON.parse(source) as unknown;
        const hello = mobileClientHelloSchema.safeParse(raw);
        if (hello.success) {
            this.helloCount += 1;
            if (hello.data.mode !== 'pair') throw new Error('Expected pair hello');
            const serverPublicKey = mobilePublicKey(serverSecret);
            this.#transcript = {
                mode: 'pair',
                serverId,
                principalId: `paired-device:${deviceId}`,
                connectionId: decodeHex(connectionId, 16),
                clientPublicKey: decodeHex(hello.data.clientPublicKey, 32),
                serverPublicKey,
                clientNonce: decodeHex(hello.data.clientNonce, 32),
                serverNonce,
            };
            this.#keys = deriveMobileSessionKeys({
                localSecretKey: serverSecret,
                peerPublicKey: this.#transcript.clientPublicKey,
                presharedKey: decodeHex(pairingSecret, 32),
                transcript: this.#transcript,
            });
            this.#message({
                type: 'challenge',
                version: MOBILE_TRANSPORT_VERSION,
                connectionId,
                deviceId,
                generation: 1,
                serverPublicKey: encodeHex(serverPublicKey),
                serverNonce: encodeHex(serverNonce),
                confirmation: encodeHex(handshakeConfirmation(this.#keys, 'server')),
            });
            return;
        }

        const confirmation = mobileClientConfirmationSchema.safeParse(raw);
        if (confirmation.success) {
            if (
                !this.#keys ||
                !isHandshakeConfirmationValid(
                    decodeHex(confirmation.data.confirmation, 32),
                    this.#keys,
                    'client',
                )
            )
                throw new Error('Client confirmation failed');
            this.#sealed({
                type: 'paired',
                deviceId,
                generation: 1,
                credential: deviceCredential,
                projectIds: ['project-1'],
            });
            if (this.#shouldRevokeAfterPair) {
                this.sendRevoked();
                queueMicrotask(() => this.close());
            }
            return;
        }

        if (!this.#keys || !this.#transcript) throw new Error('Handshake is incomplete');
        if (this.#shouldFailNextSealedSend) {
            this.#shouldFailNextSealedSend = false;
            throw new Error('Fixture send failed');
        }
        if (this.#shouldDropRequests) return;
        const frame = mobileSealedFrameSchema.parse(raw);
        const plaintext = openMobileFrame(
            this.#keys.clientToServer,
            {
                connectionId: this.#transcript.connectionId,
                counter: frame.counter,
                deviceId,
                direction: 'client-to-server',
            },
            decodeHex(frame.ciphertext),
        );
        const decodedSource = new TextDecoder().decode(plaintext);
        const request = JSON.parse(decodedSource) as { id: string; method: string };
        if (request.method !== 'project.query') throw new Error('Unexpected method');
        this.#sealed({
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: request.id,
            ok: true,
            result: {
                view: 'paired-device',
                projects: [{ id: 'project-1', displayTitle: 'Fixture' }],
            },
        });
    }

    sendRevoked(isAuthenticated = true): void {
        this.#sealed(
            { type: 'revoked', deviceId, generation: 1 },
            isAuthenticated ? undefined : decodeHex('ff'.repeat(32)),
        );
    }
}

class VersionMismatchSocket extends EventTarget {
    constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    close(): void {
        this.dispatchEvent(new Event('close'));
    }

    send(): void {
        queueMicrotask(() =>
            this.dispatchEvent(
                new MessageEvent('message', {
                    data: JSON.stringify({ type: 'version-mismatch', supportedVersion: 2 }),
                }),
            ),
        );
    }
}

class NeverOpenSocket extends EventTarget {
    isClosed = false;

    close(): void {
        this.isClosed = true;
        this.dispatchEvent(new Event('close'));
    }
}

class UnverifiedReconnectSocket extends EventTarget {
    constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    close(): void {
        this.dispatchEvent(new Event('close'));
    }

    send(source: string): void {
        const hello = mobileClientHelloSchema.parse(JSON.parse(source));
        if (hello.mode !== 'connect') throw new Error('Expected reconnect hello');
        const untrustedSecret = decodeHex('99'.repeat(32));
        const serverPublicKey = mobilePublicKey(untrustedSecret);
        const transcript: HandshakeTranscript = {
            mode: 'connect',
            serverId,
            principalId: `paired-device:${deviceId}`,
            connectionId: decodeHex(connectionId, 16),
            clientPublicKey: decodeHex(hello.clientPublicKey, 32),
            serverPublicKey,
            clientNonce: decodeHex(hello.clientNonce, 32),
            serverNonce,
        };
        const untrustedKeys = deriveMobileSessionKeys({
            localSecretKey: untrustedSecret,
            peerPublicKey: transcript.clientPublicKey,
            presharedKey: decodeHex('aa'.repeat(32)),
            transcript,
        });
        const data = JSON.stringify({
            type: 'challenge',
            version: MOBILE_TRANSPORT_VERSION,
            connectionId,
            deviceId,
            generation: 1,
            serverPublicKey: encodeHex(serverPublicKey),
            serverNonce: encodeHex(serverNonce),
            confirmation: encodeHex(handshakeConfirmation(untrustedKeys, 'server')),
        });
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
    }
}

const mobileCredential = {
    version: 1,
    addresses: ['192.168.1.5'],
    port: 41_337,
    serverId,
    deviceId,
    generation: 1,
    credential: deviceCredential,
} satisfies MobileCredential;

const memoryStore = () => {
    const values = new Map<string, string>();
    return {
        store: createMobileCredentialStore({
            deleteItemAsync: (key) => {
                values.delete(key);
                return Promise.resolve();
            },
            getItemAsync: (key) => Promise.resolve(values.get(key) ?? null),
            setItemAsync: (key, value) => {
                values.set(key, value);
                return Promise.resolve();
            },
        }),
        values,
    };
};

const observeSettlement = async (
    operation: Promise<unknown>,
    onSettled: () => void,
): Promise<void> => {
    try {
        await operation;
    } catch {
        // Timeout and connection failure are both settled outcomes for deadline tests.
    } finally {
        onSettled();
    }
};

describe('mobile gateway client', () => {
    it('stops waiting for a socket to open after four seconds', async () => {
        const socket = new NeverOpenSocket();
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        vi.useFakeTimers();
        try {
            let isSettled = false;
            const attempt = observeSettlement(
                pairMobileGateway({
                    displayName: 'Pixel fixture',
                    pairingLink,
                    runtime,
                    store,
                }),
                () => {
                    isSettled = true;
                },
            );
            await vi.advanceTimersByTimeAsync(4_000);
            expect(isSettled).toBe(true);
            expect(socket.isClosed).toBe(true);
            await attempt;
        } finally {
            socket.close();
            await vi.advanceTimersByTimeAsync(10_000);
            vi.useRealTimers();
        }
    });

    it('races eligible sockets but sends the one-time pairing handshake only to the winner', async () => {
        const sockets: FakeGatewaySocket[] = [];
        const runtime: MobileGatewayRuntime = {
            openWebSocket: (url) => {
                const socket = new FakeGatewaySocket(false, url.includes('192.168.1.5') ? 20 : 0);
                sockets.push(socket);
                return socket as unknown as WebSocket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const link = serializeMobilePairingLink({
            version: MOBILE_TRANSPORT_VERSION,
            addresses: ['192.168.1.5', '192.168.1.6'],
            port: 41_337,
            serverId,
            pairingId: '11'.repeat(16),
            secret: pairingSecret,
            expiresAt: Date.now() + 60_000,
        });

        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink: link,
            runtime,
            store,
        });

        expect(sockets).toHaveLength(2);
        expect(sockets[0]?.helloCount).toBe(0);
        expect(sockets[0]?.isClosed).toBe(true);
        expect(sockets[1]?.helloCount).toBe(1);
        paired.connection.close();
    });

    it('classifies a version-mismatch response as terminal during reconnect', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new VersionMismatchSocket() as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        await store.save(mobileCredential);

        await expect(reconnectMobileGateway(mobileCredential, runtime, store)).rejects.toEqual(
            expect.objectContaining({ code: 'version-mismatch' }),
        );
        await expect(store.load()).resolves.toEqual(mobileCredential);
    });

    it('classifies a version-mismatch response as terminal during pairing', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new VersionMismatchSocket() as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();

        await expect(
            pairMobileGateway({
                displayName: 'Pixel fixture',
                pairingLink,
                runtime,
                store,
            }),
        ).rejects.toEqual(expect.objectContaining({ code: 'version-mismatch' }));
        await expect(store.load()).resolves.toBeNull();
    });

    it('reports an incompatible pairing link as an update requirement before opening a socket', async () => {
        const openWebSocket = vi.fn();
        const runtime: MobileGatewayRuntime = {
            openWebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const incompatibleLink = pairingLink.replace('v=1', 'v=2');

        await expect(
            pairMobileGateway({
                displayName: 'Pixel fixture',
                pairingLink: incompatibleLink,
                runtime,
                store,
            }),
        ).rejects.toEqual(expect.objectContaining({ code: 'version-mismatch' }));
        expect(openWebSocket).not.toHaveBeenCalled();
    });

    it('disconnects a half-open socket when an ordinary request times out', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket(false, 0, true) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));
        vi.useFakeTimers();
        try {
            const request = paired.connection.request('project.query', { mode: 'list' });
            const rejected = expect(request).rejects.toThrow('Caxri did not respond in time.');
            await vi.advanceTimersByTimeAsync(15_000);
            await rejected;
            await expect(termination).resolves.toBe('disconnected');
        } finally {
            vi.useRealTimers();
        }
    });

    it('times out an idempotent dashboard read after three seconds', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket(false, 0, true) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        vi.useFakeTimers();
        try {
            let isSettled = false;
            const outcome = observeSettlement(paired.connection.request('mobile.dashboard'), () => {
                isSettled = true;
            });
            expect(paired.connection.hasOutstandingMutation()).toBe(false);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(isSettled).toBe(true);
            await outcome;
        } finally {
            paired.connection.close();
            vi.useRealTimers();
        }
    });

    it('keeps the longer deadline for a write while a network is slow', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket(false, 0, true) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        vi.useFakeTimers();
        try {
            let isSettled = false;
            const outcome = observeSettlement(
                paired.connection.request('session.markRead', {
                    sessionId: 'session-1',
                    attentionEpoch: 1,
                }),
                () => {
                    isSettled = true;
                },
            );
            expect(paired.connection.hasOutstandingMutation()).toBe(true);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(isSettled).toBe(false);
            await vi.advanceTimersByTimeAsync(12_000);
            expect(isSettled).toBe(true);
            await outcome;
            expect(paired.connection.hasOutstandingMutation()).toBe(false);
        } finally {
            paired.connection.close();
            vi.useRealTimers();
        }
    });

    it('bounds the foreground probe independently from the ordinary request timeout', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket(false, 0, true) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));
        vi.useFakeTimers();
        try {
            const probe = paired.connection.probe();
            const rejected = expect(probe).rejects.toThrow(
                'Caxri did not respond to the foreground probe.',
            );
            await vi.advanceTimersByTimeAsync(1_500);
            await rejected;
            await expect(termination).resolves.toBe('disconnected');
        } finally {
            vi.useRealTimers();
        }
    });

    it('pairs, persists only the durable credential, and sends a typed encrypted request', async () => {
        let randomByte = 128;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket() as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(randomByte++),
        };
        const { store, values } = memoryStore();

        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });

        expect(await store.load()).toEqual(paired.credential);
        expect(values.values().toArray().join('')).not.toContain(pairingSecret);
        await expect(paired.connection.request('project.query', { mode: 'list' })).resolves.toEqual(
            {
                view: 'paired-device',
                projects: [{ id: 'project-1', displayTitle: 'Fixture' }],
            },
        );
        paired.connection.close();
    });

    it('clears the durable credential only after an authenticated revoked payload', async () => {
        let socket: FakeGatewaySocket | undefined;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => {
                socket = new FakeGatewaySocket();
                return socket as unknown as WebSocket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));

        socket?.sendRevoked();

        await expect(termination).resolves.toBe('revoked');
        await expect(store.load()).resolves.toBeNull();
        const lateListener = vi.fn();
        paired.connection.onTermination(lateListener);
        expect(lateListener).toHaveBeenCalledExactlyOnceWith('revoked');
    });

    it('consumes a delivered revoked payload when the peer closes during pairing handoff', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket(true) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));

        await expect(termination).resolves.toBe('revoked');
        await expect(store.load()).resolves.toBeNull();
    });

    it('preserves the durable credential when an unauthenticated frame imitates revocation', async () => {
        let socket: FakeGatewaySocket | undefined;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => {
                socket = new FakeGatewaySocket();
                return socket as unknown as WebSocket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));

        socket?.sendRevoked(false);

        await expect(termination).resolves.toBe('disconnected');
        await expect(store.load()).resolves.toEqual(paired.credential);
    });

    it('terminates and clears a pending request when the socket send fails synchronously', async () => {
        let socket: FakeGatewaySocket | undefined;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => {
                socket = new FakeGatewaySocket();
                return socket as unknown as WebSocket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));
        socket?.failNextSealedSend();

        await expect(paired.connection.request('project.query', { mode: 'list' })).rejects.toThrow(
            'Fixture send failed',
        );
        await expect(termination).resolves.toBe('disconnected');
        await expect(store.load()).resolves.toEqual(paired.credential);
    });

    it('classifies an unverifiable reconnect without clearing the stored credential', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new UnverifiedReconnectSocket() as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        await store.save(mobileCredential);

        await expect(reconnectMobileGateway(mobileCredential, runtime, store)).rejects.toEqual(
            expect.objectContaining<Partial<MobileReconnectError>>({ code: 'unverified' }),
        );
        await expect(store.load()).resolves.toEqual(mobileCredential);
    });
});
