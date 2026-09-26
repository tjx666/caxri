import type {
    HandshakeTranscript,
    MobileClientPayload,
    MobileSessionKeys,
    MobileSubscriptionResource,
} from '@caxri/mobile-transport';
import {
    decodeHex,
    deriveMobileSessionKeys,
    encodeHex,
    HANDSHAKE_NONCE_BYTES,
    handshakeConfirmation,
    isHandshakeConfirmationValid,
    MOBILE_GATEWAY_MAX_WIRE_BYTES,
    MOBILE_TRANSPORT_VERSION,
    mobileClientConfirmationSchema,
    MobileFrameCounter,
    mobilePairingResultSchema,
    mobilePublicKey,
    MobileReplayGuard,
    mobileSealedFrameSchema,
    mobileServerHelloSchema,
    mobileServerPayloadSchema,
    mobileSubscribeResultSchema,
    mobileUnsubscribeResultSchema,
    mobileVersionMismatchSchema,
    openMobileFrame,
    PAIRING_SECRET_BYTES,
    parseMobilePairingLink,
    sealMobileFrame,
    X25519_KEY_BYTES,
} from '@caxri/mobile-transport';
import type {
    CaxriMethod,
    CommandReplyEnvelope,
    MethodResult,
    ParametersArgument,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    mobileDeviceIdSchema,
    parseCaxriResult,
    requestEnvelopeSchema,
} from '@caxri/protocol';
import { z } from 'zod';

import type { MobileCredential, MobileCredentialStore } from './credential-store';
import type { MobileSubscriptionListener } from './mobile-frame-router';
import { MobileFrameRouter } from './mobile-frame-router';
import { MobileHeartbeat } from './mobile-heartbeat';
import { isFastMobileRead } from './mobile-read-timeouts';
import { pairingClientHello } from './pairing-client-hello';
import { pairingCredential } from './pairing-credential';
import { createPairingSocketRuntime } from './pairing-socket-runtime';
import { MobileSocketReaderBudget } from './socket-reader-budget';

const HANDSHAKE_TIMEOUT_MS = 10_000;
const SOCKET_OPEN_TIMEOUT_MS = 4_000;
const READ_REQUEST_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;
const FOREGROUND_PROBE_TIMEOUT_MS = 1_500;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export class MobileGatewayRequestError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'MobileGatewayRequestError';
        this.code = code;
    }
}

export class MobileGatewayTimeoutError extends Error {
    constructor() {
        super('Caxri did not respond in time.');
        this.name = 'MobileGatewayTimeoutError';
    }
}

export type MobilePairingErrorCode = 'expired' | 'invalid-link' | 'rejected' | 'unreachable';

export class MobilePairingError extends Error {
    readonly code: MobilePairingErrorCode;

    constructor(code: MobilePairingErrorCode, message: string) {
        super(message);
        this.name = 'MobilePairingError';
        this.code = code;
    }
}

export class MobileReconnectError extends Error {
    readonly code = 'unverified' as const;

    constructor() {
        super('Caxri could not verify this stored pairing.');
        this.name = 'MobileReconnectError';
    }
}

export class MobileVersionMismatchError extends Error {
    readonly code = 'version-mismatch' as const;

    constructor() {
        super(
            'This app and Caxri on your computer use different versions. Update both to the latest build.',
        );
        this.name = 'MobileVersionMismatchError';
    }
}

class MobileServerVerificationError extends Error {
    constructor() {
        super('Caxri could not verify this pairing.');
        this.name = 'MobileServerVerificationError';
    }
}

export interface MobileGatewayRuntime {
    openWebSocket(url: string): WebSocket;
    platform: 'android' | 'ios';
    randomBytes(length: number): Uint8Array;
}

const mobileReadySchema = z.strictObject({
    type: z.literal('ready'),
    deviceId: mobileDeviceIdSchema,
    generation: z.number().int().positive(),
});

interface SocketReader {
    close(): void;
    next(timeoutMs?: number): Promise<unknown>;
}

const eventError = (): Error => new Error('The Caxri connection closed.');

const createSocketReader = (socket: WebSocket): SocketReader => {
    const queued: Array<{ release(): void; value: unknown }> = [];
    const waiting: Array<{ reject(error: Error): void; resolve(value: unknown): void }> = [];
    const budget = new MobileSocketReaderBudget();
    let isClosed = false;

    /**
     * A peer close may follow a final authenticated frame before the owner advances to its steady-state reader. Keep
     * already parsed frames available in that case; explicit local cleanup and protocol failures discard them.
     */
    const rejectAll = (shouldDiscardQueued: boolean): void => {
        isClosed = true;
        const pendingRequests = [...waiting];
        waiting.length = 0;
        if (shouldDiscardQueued) {
            const queuedMessages = [...queued];
            queued.length = 0;
            for (const item of queuedMessages) item.release();
        }
        for (const pending of pendingRequests) pending.reject(eventError());
    };
    socket.addEventListener('message', (event) => {
        if (isClosed) return;
        if (typeof event.data !== 'string') {
            socket.close();
            rejectAll(true);
            return;
        }
        if (event.data.length > MOBILE_GATEWAY_MAX_WIRE_BYTES) {
            socket.close();
            rejectAll(true);
            return;
        }
        // Server wire messages are ASCII JSON, so code-unit length is also their UTF-8 byte length.
        const byteLength = event.data.length;
        const release = budget.tryAcquire(byteLength);
        if (!release) {
            socket.close();
            rejectAll(true);
            return;
        }
        let value: unknown;
        try {
            value = JSON.parse(event.data) as unknown;
        } catch {
            release();
            socket.close();
            rejectAll(true);
            return;
        }
        const pending = waiting.shift();
        if (pending) {
            release();
            pending.resolve(value);
        } else queued.push({ release, value });
    });
    socket.addEventListener('close', () => rejectAll(false));
    socket.addEventListener('error', () => rejectAll(false));

    return {
        close: () => rejectAll(true),
        next: (timeoutMs) => {
            const item = queued.shift();
            if (item) {
                item.release();
                return Promise.resolve(item.value);
            }
            if (isClosed) return Promise.reject(eventError());
            return new Promise((resolve, reject) => {
                const timeout: { handle?: ReturnType<typeof setTimeout> } = {};
                const pending = {
                    resolve: (result: unknown) => {
                        clearTimeout(timeout.handle);
                        resolve(result);
                    },
                    reject: (error: Error) => {
                        clearTimeout(timeout.handle);
                        reject(error);
                    },
                };
                if (timeoutMs !== undefined)
                    timeout.handle = setTimeout(() => {
                        const index = waiting.indexOf(pending);
                        if (index !== -1) waiting.splice(index, 1);
                        reject(new Error('Caxri did not respond in time.'));
                    }, timeoutMs);
                waiting.push(pending);
            });
        },
    };
};

const openSocketAt = async (
    address: string,
    port: number,
    runtime: MobileGatewayRuntime,
    onSocket: (socket: WebSocket) => void,
): Promise<WebSocket> => {
    const socket = runtime.openWebSocket(`ws://${address}:${port}/mobile`);
    onSocket(socket);
    await new Promise<void>((resolve, reject) => {
        const timeout: { handle?: ReturnType<typeof setTimeout> } = {};
        function cleanup(): void {
            clearTimeout(timeout.handle);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', onError);
            socket.removeEventListener('close', onError);
        }
        function onError(): void {
            cleanup();
            socket.close();
            reject(new MobilePairingError('unreachable', 'Caxri could not be reached.'));
        }
        function onOpen(): void {
            cleanup();
            resolve();
        }
        timeout.handle = setTimeout(onError, SOCKET_OPEN_TIMEOUT_MS);
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
        socket.addEventListener('close', onError, { once: true });
    });
    return socket;
};

const openSocket = async (
    addresses: string[],
    port: number,
    runtime: MobileGatewayRuntime,
): Promise<WebSocket> => {
    const sockets: WebSocket[] = [];
    try {
        const winner = await Promise.any(
            addresses.map((address) =>
                openSocketAt(address, port, runtime, (socket) => sockets.push(socket)),
            ),
        );
        for (const socket of sockets) if (socket !== winner) socket.close();
        return winner;
    } catch {
        for (const socket of sockets) socket.close();
        throw new MobilePairingError('unreachable', 'Caxri could not be reached.');
    }
};

interface EstablishedSession {
    connectionId: Uint8Array;
    connectionIdHex: string;
    deviceId: string;
    generation: number;
    inbound: MobileReplayGuard;
    keys: MobileSessionKeys;
    outbound: MobileFrameCounter;
    reader: SocketReader;
    runtime: MobileGatewayRuntime;
    socket: WebSocket;
}

const receiveSealed = async (session: EstablishedSession, timeoutMs?: number): Promise<unknown> => {
    const frame = mobileSealedFrameSchema.parse(await session.reader.next(timeoutMs));
    if (frame.connectionId !== session.connectionIdHex)
        throw new Error('Connection identity changed.');
    session.inbound.assertAndAdvance(frame.counter);
    const plaintext = openMobileFrame(
        session.keys.serverToClient,
        {
            connectionId: session.connectionId,
            counter: frame.counter,
            deviceId: session.deviceId,
            direction: 'server-to-client',
        },
        decodeHex(frame.ciphertext),
    );
    const source = textDecoder.decode(plaintext);
    return JSON.parse(source) as unknown;
};

const sendSealed = (session: EstablishedSession, payload: unknown): void => {
    const counter = session.outbound.take();
    const ciphertext = sealMobileFrame(
        session.keys.clientToServer,
        {
            connectionId: session.connectionId,
            counter,
            deviceId: session.deviceId,
            direction: 'client-to-server',
        },
        textEncoder.encode(JSON.stringify(payload)),
    );
    const frame = mobileSealedFrameSchema.parse({
        type: 'sealed',
        version: MOBILE_TRANSPORT_VERSION,
        connectionId: session.connectionIdHex,
        counter,
        ciphertext: encodeHex(ciphertext),
    });
    session.socket.send(JSON.stringify(frame));
};

const establish = async (input: {
    addresses: string[];
    clientHello: Record<string, unknown>;
    clientNonce: Uint8Array;
    clientSecretKey: Uint8Array;
    expectedServerId: string;
    mode: 'connect' | 'pair';
    port: number;
    presharedKey: Uint8Array;
    runtime: MobileGatewayRuntime;
}): Promise<EstablishedSession> => {
    const socket = await openSocket(input.addresses, input.port, input.runtime);
    const reader = createSocketReader(socket);
    try {
        socket.send(JSON.stringify(input.clientHello));
        const response = await reader.next(HANDSHAKE_TIMEOUT_MS);
        if (mobileVersionMismatchSchema.safeParse(response).success)
            throw new MobileVersionMismatchError();
        const challenge = mobileServerHelloSchema.parse(response);
        const transcript: HandshakeTranscript = {
            mode: input.mode,
            serverId: input.expectedServerId,
            principalId: `paired-device:${challenge.deviceId}`,
            connectionId: decodeHex(challenge.connectionId, 16),
            clientPublicKey: mobilePublicKey(input.clientSecretKey),
            serverPublicKey: decodeHex(challenge.serverPublicKey, X25519_KEY_BYTES),
            clientNonce: input.clientNonce,
            serverNonce: decodeHex(challenge.serverNonce, HANDSHAKE_NONCE_BYTES),
        };
        const keys = deriveMobileSessionKeys({
            localSecretKey: input.clientSecretKey,
            peerPublicKey: transcript.serverPublicKey,
            presharedKey: input.presharedKey,
            transcript,
        });
        if (!isHandshakeConfirmationValid(decodeHex(challenge.confirmation, 32), keys, 'server'))
            throw new MobileServerVerificationError();
        const confirmation = mobileClientConfirmationSchema.parse({
            type: 'confirm',
            version: MOBILE_TRANSPORT_VERSION,
            connectionId: challenge.connectionId,
            confirmation: encodeHex(handshakeConfirmation(keys, 'client')),
        });
        socket.send(JSON.stringify(confirmation));
        return {
            connectionId: transcript.connectionId,
            connectionIdHex: challenge.connectionId,
            deviceId: challenge.deviceId,
            generation: challenge.generation,
            inbound: new MobileReplayGuard(),
            keys,
            outbound: new MobileFrameCounter(),
            reader,
            runtime: input.runtime,
            socket,
        };
    } catch (error) {
        reader.close();
        socket.close();
        throw error;
    }
};

export type MobileGatewayTermination = 'disconnected' | 'revoked';

export interface MobileGatewaySubscriptionHandle {
    subscriptionId: string;
    unsubscribe(): Promise<void>;
}

export class MobileGatewayConnection {
    readonly #clearCredential: () => Promise<void>;
    readonly #heartbeat: MobileHeartbeat;
    readonly #listeners = new Set<(reason: MobileGatewayTermination) => void>();
    readonly #observationListeners = new Set<() => void>();
    readonly #router = new MobileFrameRouter();
    readonly #session: EstablishedSession;
    #closedByOwner = false;
    #deferredLivenessError?: Error;
    /**
     * A timed-out mutation may have reached the server; later traffic cannot make retry safe.
     */
    #deferredMutationError?: Error;
    #isForeground = false;
    #outstandingMutations = 0;
    #subscriptionQueue = Promise.resolve();
    #termination?: MobileGatewayTermination;

    constructor(session: EstablishedSession, clearCredential: () => Promise<void>) {
        this.#session = session;
        this.#clearCredential = clearCredential;
        this.#heartbeat = new MobileHeartbeat({
            onTimeout: () => {
                const error = new Error('Caxri did not acknowledge the heartbeat.');
                if (this.hasOutstandingMutation()) this.#deferredLivenessError = error;
                else this.#finish('disconnected', error);
            },
            randomBytes: (size) => session.runtime.randomBytes(size),
            send: (payload) => sendSealed(session, payload),
        });
        // eslint-disable-next-line no-void -- The connection lifetime owns its single inbound frame pump.
        void this.#readLoop();
    }

    #finish(reason: MobileGatewayTermination, error: Error): void {
        if (this.#termination || this.#closedByOwner) return;
        this.#termination = reason;
        this.#heartbeat.stop();
        this.#router.rejectAll(error);
        this.#session.reader.close();
        this.#session.socket.close();
        for (const listener of this.#listeners) listener(reason);
    }

    /**
     * Owns the only post-handshake reader so authenticated control payloads cannot race command replies or socket
     * closure. Credential deletion occurs inside this ordered boundary before the revoked terminal state is exposed.
     */
    async #readLoop(): Promise<void> {
        try {
            while (!this.#termination && !this.#closedByOwner) {
                // eslint-disable-next-line no-await-in-loop -- one reader serializes and authenticates every server frame.
                const payload = mobileServerPayloadSchema.parse(await receiveSealed(this.#session));
                if (payload.type === 'revoked') {
                    if (
                        payload.deviceId !== this.#session.deviceId ||
                        payload.generation !== this.#session.generation
                    )
                        throw new Error('Caxri returned an unexpected revoked identity.');
                    // A credential is cleared only after the control payload has passed authenticated frame opening.
                    // eslint-disable-next-line no-await-in-loop -- revocation is the terminal frame for this connection.
                    await this.#clearCredential();
                    this.#finish('revoked', new Error('This device was revoked.'));
                    return;
                }
                if (payload.type === 'reply') this.#router.receiveReply(payload.reply);
                else if (payload.type === 'heartbeat-ack')
                    this.#heartbeat.acknowledge(payload.nonce);
                else this.#router.receiveSubscriptionMessage(payload);
                this.#deferredLivenessError = undefined;
                if (this.#isForeground) this.#heartbeat.start();
                for (const listener of this.#observationListeners) listener();
            }
        } catch (error) {
            this.#finish(
                'disconnected',
                error instanceof Error ? error : new Error('The Caxri connection closed.'),
            );
        }
    }

    async #sendWithReply(
        id: string,
        payload: MobileClientPayload,
        timeoutMs: number,
        isMutation = false,
    ): Promise<CommandReplyEnvelope> {
        if (this.#termination || this.#closedByOwner) throw eventError();
        if (this.#deferredMutationError) throw this.#deferredMutationError;
        const timeoutError = new MobileGatewayTimeoutError();
        const response = this.#router.waitForReply(
            id,
            timeoutMs,
            () => {
                if (isMutation) this.#deferredMutationError = timeoutError;
                else if (this.hasOutstandingMutation()) this.#deferredLivenessError = timeoutError;
                else this.#finish('disconnected', timeoutError);
            },
            timeoutError,
        );
        try {
            sendSealed(this.#session, payload);
        } catch (error) {
            this.#finish(
                'disconnected',
                error instanceof Error ? error : new Error('The Caxri connection closed.'),
            );
        }
        return response;
    }

    close(): void {
        this.#closedByOwner = true;
        this.#heartbeat.stop();
        this.#router.rejectAll(eventError());
        this.#session.reader.close();
        this.#session.socket.close();
        this.#listeners.clear();
        this.#observationListeners.clear();
    }

    onTermination(listener: (reason: MobileGatewayTermination) => void): () => void {
        if (this.#termination) {
            listener(this.#termination);
            return () => {};
        }
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    onObservation(listener: () => void): () => void {
        this.#observationListeners.add(listener);
        return () => this.#observationListeners.delete(listener);
    }

    setForeground(isForeground: boolean): void {
        this.#isForeground = isForeground;
        if (isForeground && !this.#closedByOwner && !this.#termination) this.#heartbeat.start();
        else this.#heartbeat.stop();
    }

    hasOutstandingMutation(): boolean {
        return this.#outstandingMutations > 0;
    }

    async request<M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodResult<M>> {
        const isFastRead = isFastMobileRead(method);
        if (!isFastRead) this.#outstandingMutations += 1;
        try {
            const id = `mobile_${encodeHex(this.#session.runtime.randomBytes(16))}`;
            const reply = await this.#sendWithReply(
                id,
                {
                    type: 'request',
                    request: requestEnvelopeSchema.parse({
                        protocolVersion: CAXRI_PROTOCOL_VERSION,
                        id,
                        method,
                        params: arguments_[0] ?? {},
                    }),
                },
                isFastRead ? READ_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
                !isFastRead,
            );
            if (!reply.ok)
                throw new MobileGatewayRequestError(reply.error.code, reply.error.message);
            return parseCaxriResult(method, reply.result);
        } finally {
            if (!isFastRead) {
                this.#outstandingMutations -= 1;
                if (!this.hasOutstandingMutation()) {
                    const error = this.#deferredMutationError ?? this.#deferredLivenessError;
                    if (error) this.#finish('disconnected', error);
                }
            }
        }
    }

    async subscribe(
        resource: MobileSubscriptionResource,
        listener: MobileSubscriptionListener,
    ): Promise<MobileGatewaySubscriptionHandle> {
        const previousSubscription = this.#subscriptionQueue;
        let releaseSubscription!: () => void;
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- React Native does not provide Promise.withResolvers.
        this.#subscriptionQueue = new Promise<void>((resolve) => {
            releaseSubscription = resolve;
        });
        await previousSubscription;
        let id: string | undefined;
        try {
            id = `mobile_${encodeHex(this.#session.runtime.randomBytes(16))}`;
            this.#router.beginSubscriptionRequest(id);
            const reply = await this.#sendWithReply(
                id,
                { type: 'subscribe', id, resource },
                READ_REQUEST_TIMEOUT_MS,
            );
            if (!reply.ok)
                throw new MobileGatewayRequestError(reply.error.code, reply.error.message);
            const { subscriptionId } = mobileSubscribeResultSchema.parse(reply.result);
            if (this.#termination || this.#closedByOwner) throw eventError();
            this.#router.addSubscription(subscriptionId, resource, listener);
            let didUnsubscribe = false;
            return {
                subscriptionId,
                unsubscribe: async () => {
                    if (didUnsubscribe) return;
                    didUnsubscribe = true;
                    const isActive = this.#router.hasSubscription(subscriptionId);
                    this.#router.removeSubscription(subscriptionId);
                    if (!isActive || this.#termination || this.#closedByOwner) return;
                    const unsubscribeId = `mobile_${encodeHex(this.#session.runtime.randomBytes(16))}`;
                    const unsubscribeReply = await this.#sendWithReply(
                        unsubscribeId,
                        { type: 'unsubscribe', id: unsubscribeId, subscriptionId },
                        READ_REQUEST_TIMEOUT_MS,
                    );
                    if (!unsubscribeReply.ok)
                        throw new MobileGatewayRequestError(
                            unsubscribeReply.error.code,
                            unsubscribeReply.error.message,
                        );
                    mobileUnsubscribeResultSchema.parse(unsubscribeReply.result);
                },
            };
        } finally {
            if (id) this.#router.endSubscriptionRequest(id);
            releaseSubscription();
        }
    }

    async probe(): Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.request('mobile.dashboard'),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => {
                        const error = new Error('Caxri did not respond to the foreground probe.');
                        if (this.hasOutstandingMutation()) this.#deferredLivenessError = error;
                        else this.#finish('disconnected', error);
                        reject(error);
                    }, FOREGROUND_PROBE_TIMEOUT_MS);
                }),
            ]);
        } finally {
            clearTimeout(timeout);
        }
    }
}

export interface PairedMobileConnection {
    connection: MobileGatewayConnection;
    credential: MobileCredential;
}

const hasUnsupportedPairingLinkVersion = (source: string): boolean => {
    try {
        const url = new URL(source);
        if (url.protocol !== 'caxri:' || url.hostname !== 'pair') return false;
        const versionText = url.searchParams.get('v');
        if (versionText === null) return false;
        const version = Number(versionText);
        if (!Number.isSafeInteger(version)) return false;
        return version !== MOBILE_TRANSPORT_VERSION;
    } catch {
        return false;
    }
};

export const pairMobileGateway = async (input: {
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    displayName: string;
    pairingLink: string;
    runtime: MobileGatewayRuntime;
    store: MobileCredentialStore;
}): Promise<PairedMobileConnection> => {
    let link: ReturnType<typeof parseMobilePairingLink>;
    try {
        link = parseMobilePairingLink(input.pairingLink);
    } catch {
        if (hasUnsupportedPairingLinkVersion(input.pairingLink))
            throw new MobileVersionMismatchError();
        throw new MobilePairingError('invalid-link', 'This is not a Caxri pairing link.');
    }
    if (link.expiresAt <= Date.now())
        throw new MobilePairingError('expired', 'This pairing code has expired.');
    const clientSecretKey = input.runtime.randomBytes(X25519_KEY_BYTES);
    const clientNonce = input.runtime.randomBytes(HANDSHAKE_NONCE_BYTES);
    const { runtime, dispose } = createPairingSocketRuntime(input.runtime, input.signal);
    let session: EstablishedSession;
    try {
        session = await establish({
            addresses: link.addresses,
            port: link.port,
            mode: 'pair',
            expectedServerId: link.serverId,
            clientSecretKey,
            clientNonce,
            presharedKey: decodeHex(link.secret, PAIRING_SECRET_BYTES),
            runtime,
            clientHello: pairingClientHello({
                pairingId: link.pairingId,
                displayName: input.displayName,
                platform: input.runtime.platform,
                clientSecretKey,
                clientNonce,
            }),
        });
    } catch (error) {
        dispose();
        if (error instanceof MobilePairingError || error instanceof MobileVersionMismatchError)
            throw error;
        throw new MobilePairingError('rejected', 'Caxri could not verify this pairing.');
    }
    try {
        const paired = mobilePairingResultSchema.parse(
            await receiveSealed(session, HANDSHAKE_TIMEOUT_MS),
        );
        if (paired.deviceId !== session.deviceId)
            throw new Error('Caxri returned an unexpected device identity.');
        const credential = pairingCredential(link, paired);
        await input.store.save(
            credential,
            () => !input.signal?.aborted && (input.isCurrent?.() ?? true),
        );
        if (input.signal?.aborted) throw new Error('Pairing attempt was cancelled.');
        dispose();
        return {
            connection: new MobileGatewayConnection(session, async () => {
                await input.store.clearIfCurrent(credential);
            }),
            credential,
        };
    } catch (error) {
        dispose();
        session.reader.close();
        session.socket.close();
        throw error;
    }
};

export const reconnectMobileGateway = async (
    credential: MobileCredential,
    runtime: MobileGatewayRuntime,
    store: MobileCredentialStore,
): Promise<MobileGatewayConnection> => {
    const clientSecretKey = runtime.randomBytes(X25519_KEY_BYTES);
    const clientNonce = runtime.randomBytes(HANDSHAKE_NONCE_BYTES);
    let session: EstablishedSession;
    try {
        session = await establish({
            addresses: credential.addresses,
            port: credential.port,
            mode: 'connect',
            expectedServerId: credential.serverId,
            clientSecretKey,
            clientNonce,
            presharedKey: decodeHex(credential.credential, PAIRING_SECRET_BYTES),
            runtime,
            clientHello: {
                type: 'hello',
                version: MOBILE_TRANSPORT_VERSION,
                mode: 'connect',
                deviceId: credential.deviceId,
                generation: credential.generation,
                clientPublicKey: encodeHex(mobilePublicKey(clientSecretKey)),
                clientNonce: encodeHex(clientNonce),
            },
        });
    } catch (error) {
        if (error instanceof MobileServerVerificationError) throw new MobileReconnectError();
        throw error;
    }
    try {
        const ready = mobileReadySchema.parse(await receiveSealed(session, HANDSHAKE_TIMEOUT_MS));
        if (ready.deviceId !== credential.deviceId || ready.generation !== credential.generation)
            throw new Error('Caxri returned an unexpected device identity.');
        return new MobileGatewayConnection(session, async () => {
            await store.clearIfCurrent(credential);
        });
    } catch (error) {
        session.reader.close();
        session.socket.close();
        throw error;
    }
};
