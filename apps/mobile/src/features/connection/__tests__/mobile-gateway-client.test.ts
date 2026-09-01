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
    readonly #shouldRevokeAfterPair: boolean;
    #serverCounter = 0;
    #transcript?: HandshakeTranscript;

    constructor(shouldRevokeAfterPair = false) {
        super();
        this.#shouldRevokeAfterPair = shouldRevokeAfterPair;
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
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
        this.dispatchEvent(new Event('close'));
    }

    failNextSealedSend(): void {
        this.#shouldFailNextSealedSend = true;
    }

    send(source: string): void {
        const raw = JSON.parse(source) as unknown;
        const hello = mobileClientHelloSchema.safeParse(raw);
        if (hello.success) {
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

describe('mobile gateway client', () => {
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
