/**
 * Opening a gateway socket and running the encrypted handshake, plus the sealed-frame codec an established session
 * uses.
 */
import type { HandshakeTranscript, MobileSessionKeys } from '@caxri/mobile-transport';
import {
    decodeHex,
    deriveMobileSessionKeys,
    encodeHex,
    HANDSHAKE_NONCE_BYTES,
    handshakeConfirmation,
    isHandshakeConfirmationValid,
    MOBILE_TRANSPORT_VERSION,
    mobileClientConfirmationSchema,
    MobileFrameCounter,
    mobilePublicKey,
    MobileReplayGuard,
    mobileSealedFrameSchema,
    mobileServerHelloSchema,
    mobileVersionMismatchSchema,
    openMobileFrame,
    sealMobileFrame,
    X25519_KEY_BYTES,
} from '@caxri/mobile-transport';

import { discardSocket, isSocketDiscarded } from './discard-socket';
import type { MobileGatewayRuntime } from './mobile-gateway-client';
import {
    MobilePairingError,
    MobileServerVerificationError,
    MobileVersionMismatchError,
} from './mobile-gateway-errors';
import type { SocketReader } from './socket-reader';
import { createSocketReader } from './socket-reader';

export const HANDSHAKE_TIMEOUT_MS = 10_000;
const SOCKET_OPEN_TIMEOUT_MS = 4_000;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

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
            discardSocket(socket);
            reject(new MobilePairingError('unreachable', 'Caxri could not be reached.'));
        }
        function onOpen(): void {
            // A cancelled pairing's socket can still open on Android; it fails here and `discardSocket` closes it.
            if (isSocketDiscarded(socket)) {
                onError();
                return;
            }
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

/**
 * Races one socket per advertised address and keeps the first to open. Only the winner ever carries a hello; every
 * other candidate is discarded, including one still connecting that React Native Android would otherwise leave open.
 */
export const openSocket = async (
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
        for (const socket of sockets) if (socket !== winner) discardSocket(socket);
        return winner;
    } catch {
        // Every candidate rejects only after `openSocketAt` discarded it, so nothing is left to close here.
        throw new MobilePairingError('unreachable', 'Caxri could not be reached.');
    }
};

export interface EstablishedSession {
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

export const receiveSealed = async (
    session: EstablishedSession,
    timeoutMs?: number,
): Promise<unknown> => {
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

export const sendSealed = (session: EstablishedSession, payload: unknown): void => {
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

export const establish = async (input: {
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
        const mismatch = mobileVersionMismatchSchema.safeParse(response);
        if (mismatch.success) throw new MobileVersionMismatchError(mismatch.data.supportedVersion);
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
