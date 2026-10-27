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

import type { MobileCredential } from '../credential-store';
import { createMobileCredentialStore } from '../credential-store';

export const serverId = 'a'.repeat(32);
export const pairingSecret = '22'.repeat(32);
const connectionId = '33'.repeat(16);
const deviceId = `device_${'44'.repeat(16)}`;
const deviceCredential = '55'.repeat(32);
const serverSecret = decodeHex('66'.repeat(32));
const serverNonce = decodeHex('77'.repeat(32));
export const pairingLink = serializeMobilePairingLink({
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
export class FakeGatewaySocket extends EventTarget {
    #keys?: MobileSessionKeys;
    #shouldFailNextSealedSend = false;
    readonly #holdRequests: boolean;
    readonly #heldRequestIds: string[] = [];
    readonly #shouldDropRequests: boolean;
    readonly #shouldDropHeartbeat: boolean;
    readonly #shouldSendPreAckResync: boolean;
    readonly #shouldRevokeAfterPair: boolean;
    #serverCounter = 0;
    #transcript?: HandshakeTranscript;
    helloCount = 0;
    isClosed = false;
    heartbeatCount = 0;
    requestCount = 0;
    /**
     * Every close code this socket was closed with, in order; `undefined` for a close without one.
     */
    readonly closeCodes: Array<number | undefined> = [];

    constructor(
        shouldRevokeAfterPair = false,
        openDelayMs = 0,
        shouldDropRequests = false,
        shouldHoldRequests = false,
        shouldSendPreAckResync = false,
        shouldDropHeartbeat = false,
    ) {
        super();
        this.#shouldRevokeAfterPair = shouldRevokeAfterPair;
        this.#shouldDropRequests = shouldDropRequests;
        this.#holdRequests = shouldHoldRequests;
        this.#shouldSendPreAckResync = shouldSendPreAckResync;
        this.#shouldDropHeartbeat = shouldDropHeartbeat;
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

    #replyToProjectQuery(id: string): void {
        this.#sealed({
            type: 'reply',
            reply: {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id,
                ok: true,
                result: {
                    view: 'paired-device',
                    projects: [{ id: 'project-1', title: 'Fixture' }],
                },
            },
        });
    }

    close(code?: number): void {
        this.closeCodes.push(code);
        this.isClosed = true;
        this.dispatchEvent(new Event('close'));
    }

    failNextSealedSend(): void {
        this.#shouldFailNextSealedSend = true;
    }

    releaseHeldRequests(): void {
        for (const id of this.#heldRequestIds.toReversed()) this.#replyToProjectQuery(id);
        this.#heldRequestIds.length = 0;
    }

    releaseHeldRequestAt(index: number): void {
        const [id] = this.#heldRequestIds.splice(index, 1);
        if (!id) throw new Error('No held request at this index.');
        this.#replyToProjectQuery(id);
    }

    sendHeartbeatAck(): void {
        this.#sealed({ type: 'heartbeat-ack', nonce: '88'.repeat(16) });
    }

    sendDashboardEvent(sequence: number): void {
        this.#sealed({
            type: 'event',
            subscriptionId: 'subscription-1',
            sequence,
            kind: 'dashboard.changed',
        });
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
        const payload = JSON.parse(decodedSource) as {
            type: string;
            request?: { id: string; method: string };
            id?: string;
            subscriptionId?: string;
            nonce?: string;
        };
        if (payload.type === 'heartbeat') {
            this.heartbeatCount += 1;
            if (!this.#shouldDropHeartbeat)
                this.#sealed({ type: 'heartbeat-ack', nonce: payload.nonce });
            return;
        }
        if (payload.type === 'subscribe') {
            if (this.#shouldSendPreAckResync)
                this.#sealed({
                    type: 'event',
                    subscriptionId: 'subscription-1',
                    sequence: 0,
                    kind: 'resync-required',
                    reason: 'capacity',
                });
            this.#sealed({
                type: 'reply',
                reply: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: payload.id,
                    ok: true,
                    result: { subscriptionId: 'subscription-1' },
                },
            });
            return;
        }
        if (payload.type === 'unsubscribe') {
            this.#sealed({
                type: 'reply',
                reply: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: payload.id,
                    ok: true,
                    result: {},
                },
            });
            return;
        }
        if (payload.type !== 'request' || !payload.request)
            throw new Error('Expected request payload');
        const request = payload.request;
        if (request.method !== 'project.query') throw new Error('Unexpected method');
        this.requestCount += 1;
        if (this.#holdRequests) {
            this.#heldRequestIds.push(request.id);
            return;
        }
        this.#replyToProjectQuery(request.id);
    }

    sendRevoked(isAuthenticated = true): void {
        this.#sealed(
            { type: 'revoked', deviceId, generation: 1 },
            isAuthenticated ? undefined : decodeHex('ff'.repeat(32)),
        );
    }
}

export class VersionMismatchSocket extends EventTarget {
    readonly #supportedVersion: number;

    constructor(supportedVersion = 1) {
        super();
        this.#supportedVersion = supportedVersion;
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    close(): void {
        this.dispatchEvent(new Event('close'));
    }

    send(): void {
        queueMicrotask(() =>
            this.dispatchEvent(
                new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'version-mismatch',
                        supportedVersion: this.#supportedVersion,
                    }),
                }),
            ),
        );
    }
}

export class NeverOpenSocket extends EventTarget {
    isClosed = false;

    close(): void {
        this.isClosed = true;
        this.dispatchEvent(new Event('close'));
    }
}

/**
 * Mirrors React Native Android, whose native module registers a socket only when it opens: `close()` while CONNECTING
 * is silently ignored and the socket still opens later (https://github.com/facebook/react-native/issues/35554). A test
 * drives the late open with `open()`.
 */
export class AndroidConnectingSocket extends EventTarget {
    #state: 'closed' | 'connecting' | 'open' = 'connecting';
    readonly sent: string[] = [];

    get isClosed(): boolean {
        return this.#state === 'closed';
    }

    close(): void {
        if (this.#state !== 'open') return;
        this.#state = 'closed';
        this.dispatchEvent(new Event('close'));
    }

    open(): void {
        if (this.#state !== 'connecting') throw new Error('Socket is not connecting.');
        this.#state = 'open';
        this.dispatchEvent(new Event('open'));
    }

    send(data: string): void {
        if (this.#state !== 'open') throw new Error('INVALID_STATE_ERR');
        this.sent.push(data);
    }
}

export class UnverifiedReconnectSocket extends EventTarget {
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

export const mobileCredential = {
    version: 1,
    addresses: ['192.168.1.5'],
    port: 41_337,
    serverId,
    deviceId,
    generation: 1,
    credential: deviceCredential,
} satisfies MobileCredential;

export const memoryStore = () => {
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

/**
 * Drains every queued microtask, so a socket event's full async continuation has run before the test asserts.
 */
export const flushTasks = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

export const observeSettlement = async (
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
