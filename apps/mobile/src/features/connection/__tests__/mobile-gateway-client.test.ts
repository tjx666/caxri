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
import { describe, expect, it } from 'vitest';

import { createMobileCredentialStore } from '../credential-store';
import type { MobileGatewayRuntime } from '../mobile-gateway-client';
import { pairMobileGateway } from '../mobile-gateway-client';

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
    #transcript?: HandshakeTranscript;

    constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    #message(value: unknown): void {
        const data = JSON.stringify(value);
        queueMicrotask(() => {
            this.dispatchEvent(new MessageEvent('message', { data }));
        });
    }

    #sealed(counter: number, value: unknown): void {
        if (!this.#keys || !this.#transcript) throw new Error('Handshake is incomplete');
        const source = JSON.stringify(value);
        const ciphertext = sealMobileFrame(
            this.#keys.serverToClient,
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
            this.#sealed(0, {
                type: 'paired',
                deviceId,
                generation: 1,
                credential: deviceCredential,
                projectIds: ['project-1'],
            });
            return;
        }

        if (!this.#keys || !this.#transcript) throw new Error('Handshake is incomplete');
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
        this.#sealed(1, {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: request.id,
            ok: true,
            result: {
                view: 'paired-device',
                projects: [{ id: 'project-1', displayTitle: 'Fixture' }],
            },
        });
    }
}

describe('mobile gateway client', () => {
    it('pairs, persists only the durable credential, and sends a typed encrypted request', async () => {
        let randomByte = 128;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket() as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(randomByte++),
        };
        const values = new Map<string, string>();
        const store = createMobileCredentialStore({
            deleteItemAsync: (key) => {
                values.delete(key);
                return Promise.resolve();
            },
            getItemAsync: (key) => Promise.resolve(values.get(key) ?? null),
            setItemAsync: (key, value) => {
                values.set(key, value);
                return Promise.resolve();
            },
        });

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
});
