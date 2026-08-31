import type { HandshakeTranscript, MobileSessionKeys } from '@caxri/mobile-transport';
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
    openMobileFrame,
    PAIRING_SECRET_BYTES,
    parseMobilePairingLink,
    sealMobileFrame,
    X25519_KEY_BYTES,
} from '@caxri/mobile-transport';
import type { CaxriMethod, MethodResult, ParametersArgument } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    commandReplyEnvelopeSchema,
    mobileDeviceIdSchema,
    parseCaxriResult,
} from '@caxri/protocol';
import { z } from 'zod';

import type { MobileCredential, MobileCredentialStore } from './credential-store';
import { MobileSocketReaderBudget } from './socket-reader-budget';

const HANDSHAKE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
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

export type MobilePairingErrorCode = 'expired' | 'invalid-link' | 'rejected' | 'unreachable';

export class MobilePairingError extends Error {
    readonly code: MobilePairingErrorCode;

    constructor(code: MobilePairingErrorCode, message: string) {
        super(message);
        this.name = 'MobilePairingError';
        this.code = code;
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
    next(timeoutMs: number): Promise<unknown>;
}

const eventError = (): Error => new Error('The Caxri connection closed.');

const createSocketReader = (socket: WebSocket): SocketReader => {
    const queued: Array<{ release(): void; value: unknown }> = [];
    const waiting: Array<{ reject(error: Error): void; resolve(value: unknown): void }> = [];
    const budget = new MobileSocketReaderBudget();
    let isClosed = false;

    const rejectAll = (): void => {
        if (isClosed) return;
        isClosed = true;
        const pendingRequests = [...waiting];
        const queuedMessages = [...queued];
        waiting.length = 0;
        queued.length = 0;
        for (const item of queuedMessages) item.release();
        for (const pending of pendingRequests) pending.reject(eventError());
    };
    socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
            socket.close();
            rejectAll();
            return;
        }
        if (event.data.length > MOBILE_GATEWAY_MAX_WIRE_BYTES) {
            socket.close();
            rejectAll();
            return;
        }
        // Server wire messages are ASCII JSON, so code-unit length is also their UTF-8 byte length.
        const byteLength = event.data.length;
        const release = budget.tryAcquire(byteLength);
        if (!release) {
            socket.close();
            rejectAll();
            return;
        }
        let value: unknown;
        try {
            value = JSON.parse(event.data) as unknown;
        } catch {
            release();
            socket.close();
            rejectAll();
            return;
        }
        const pending = waiting.shift();
        if (pending) {
            release();
            pending.resolve(value);
        } else queued.push({ release, value });
    });
    socket.addEventListener('close', rejectAll);
    socket.addEventListener('error', rejectAll);

    return {
        close: rejectAll,
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
): Promise<WebSocket> => {
    const socket = runtime.openWebSocket(`ws://${address}:${port}/mobile`);
    await new Promise<void>((resolve, reject) => {
        const timeout: { handle?: ReturnType<typeof setTimeout> } = {};
        const onError = (): void => {
            clearTimeout(timeout.handle);
            socket.close();
            reject(new MobilePairingError('unreachable', 'Caxri could not be reached.'));
        };
        const onOpen = (): void => {
            clearTimeout(timeout.handle);
            socket.removeEventListener('error', onError);
            resolve();
        };
        timeout.handle = setTimeout(() => {
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', onError);
            socket.close();
            reject(new MobilePairingError('unreachable', 'Caxri could not be reached.'));
        }, HANDSHAKE_TIMEOUT_MS);
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
    });
    return socket;
};

const openSocket = async (
    addresses: string[],
    port: number,
    runtime: MobileGatewayRuntime,
): Promise<WebSocket> => {
    for (const address of addresses) {
        try {
            // eslint-disable-next-line no-await-in-loop -- candidates are tried in advertised reachability order.
            return await openSocketAt(address, port, runtime);
        } catch {
            // Continue to the next private interface advertised by the same authenticated Server.
        }
    }
    throw new MobilePairingError('unreachable', 'Caxri could not be reached.');
};

interface EstablishedSession {
    connectionId: Uint8Array;
    connectionIdHex: string;
    deviceId: string;
    inbound: MobileReplayGuard;
    keys: MobileSessionKeys;
    outbound: MobileFrameCounter;
    reader: SocketReader;
    runtime: MobileGatewayRuntime;
    socket: WebSocket;
}

const receiveSealed = async (session: EstablishedSession, timeoutMs: number): Promise<unknown> => {
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
        const challenge = mobileServerHelloSchema.parse(await reader.next(HANDSHAKE_TIMEOUT_MS));
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
            throw new Error('Caxri could not verify this pairing.');
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

export class MobileGatewayConnection {
    readonly #session: EstablishedSession;
    #requestSequence = Promise.resolve();

    constructor(session: EstablishedSession) {
        this.#session = session;
    }

    close(): void {
        this.#session.reader.close();
        this.#session.socket.close();
    }

    async request<M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodResult<M>> {
        const previousRequest = this.#requestSequence;
        const currentRequest = (async (): Promise<MethodResult<M>> => {
            await previousRequest;
            const id = `mobile_${encodeHex(this.#session.runtime.randomBytes(16))}`;
            sendSealed(this.#session, {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id,
                method,
                params: arguments_[0] ?? {},
            });
            const reply = commandReplyEnvelopeSchema.parse(
                await receiveSealed(this.#session, REQUEST_TIMEOUT_MS),
            );
            if (reply.id !== id) throw new Error('Caxri returned an unexpected reply.');
            if (!reply.ok)
                throw new MobileGatewayRequestError(reply.error.code, reply.error.message);
            return parseCaxriResult(method, reply.result);
        })();
        this.#requestSequence = (async (): Promise<void> => {
            try {
                await currentRequest;
            } catch {
                // A failed request releases the queue; the caller still receives the original error.
            }
        })();
        return currentRequest;
    }
}

export interface PairedMobileConnection {
    connection: MobileGatewayConnection;
    credential: MobileCredential;
}

export const pairMobileGateway = async (input: {
    displayName: string;
    pairingLink: string;
    runtime: MobileGatewayRuntime;
    store: MobileCredentialStore;
}): Promise<PairedMobileConnection> => {
    let link: ReturnType<typeof parseMobilePairingLink>;
    try {
        link = parseMobilePairingLink(input.pairingLink);
    } catch {
        throw new MobilePairingError('invalid-link', 'This is not a Caxri pairing link.');
    }
    if (link.expiresAt <= Date.now())
        throw new MobilePairingError('expired', 'This pairing code has expired.');
    const clientSecretKey = input.runtime.randomBytes(X25519_KEY_BYTES);
    const clientNonce = input.runtime.randomBytes(HANDSHAKE_NONCE_BYTES);
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
            runtime: input.runtime,
            clientHello: {
                type: 'hello',
                version: MOBILE_TRANSPORT_VERSION,
                mode: 'pair',
                pairingId: link.pairingId,
                displayName: input.displayName.trim().slice(0, 100) || 'Mobile device',
                platform: input.runtime.platform,
                clientPublicKey: encodeHex(mobilePublicKey(clientSecretKey)),
                clientNonce: encodeHex(clientNonce),
            },
        });
    } catch (error) {
        if (error instanceof MobilePairingError) throw error;
        throw new MobilePairingError('rejected', 'Caxri could not verify this pairing.');
    }
    try {
        const paired = mobilePairingResultSchema.parse(
            await receiveSealed(session, HANDSHAKE_TIMEOUT_MS),
        );
        if (paired.deviceId !== session.deviceId)
            throw new Error('Caxri returned an unexpected device identity.');
        const credential = {
            version: 1,
            addresses: link.addresses,
            port: link.port,
            serverId: link.serverId,
            deviceId: paired.deviceId,
            generation: paired.generation,
            credential: paired.credential,
        } as const satisfies MobileCredential;
        await input.store.save(credential);
        return { connection: new MobileGatewayConnection(session), credential };
    } catch (error) {
        session.reader.close();
        session.socket.close();
        throw error;
    }
};

export const reconnectMobileGateway = async (
    credential: MobileCredential,
    runtime: MobileGatewayRuntime,
): Promise<MobileGatewayConnection> => {
    const clientSecretKey = runtime.randomBytes(X25519_KEY_BYTES);
    const clientNonce = runtime.randomBytes(HANDSHAKE_NONCE_BYTES);
    const session = await establish({
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
    try {
        const ready = mobileReadySchema.parse(await receiveSealed(session, HANDSHAKE_TIMEOUT_MS));
        if (ready.deviceId !== credential.deviceId || ready.generation !== credential.generation)
            throw new Error('Caxri returned an unexpected device identity.');
        return new MobileGatewayConnection(session);
    } catch (error) {
        session.reader.close();
        session.socket.close();
        throw error;
    }
};
