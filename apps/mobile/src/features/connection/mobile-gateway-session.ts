/**
 * Opening a gateway socket and running the encrypted handshake, plus the sealed-frame codec an established session
 * uses.
 */
import type {
    HandshakeTranscript,
    MobileConnectTrace,
    MobileSessionKeys,
} from '@caxri/mobile-transport';
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

import type { MobileGatewayRoute, MobileGatewayRouteKind } from './gateway-routes';
import { DIRECT_ROUTE_GRACE_MS, gatewayRoutes, openGatewaySocket } from './gateway-routes';
import type { MobileGatewayRuntime } from './mobile-gateway-client';
import { MobileServerVerificationError, MobileVersionMismatchError } from './mobile-gateway-errors';
import type { SocketReader } from './socket-reader';
import { createSocketReader } from './socket-reader';

export const HANDSHAKE_TIMEOUT_MS = 10_000;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * Opens one socket to a paired computer over its direct addresses only. Update recovery and direct-route probes use it:
 * neither may travel through the Relay.
 */
export const openSocket = async (
    addresses: string[],
    port: number,
    runtime: MobileGatewayRuntime,
): Promise<WebSocket> =>
    (await openGatewaySocket(gatewayRoutes({ addresses, port }), runtime)).socket;

export interface EstablishedSession {
    connectionId: Uint8Array;
    connectionIdHex: string;
    deviceId: string;
    generation: number;
    inbound: MobileReplayGuard;
    keys: MobileSessionKeys;
    outbound: MobileFrameCounter;
    reader: SocketReader;
    /**
     * The path that won the route race; a Relay session probes for a direct path to move back to.
     */
    route: MobileGatewayRouteKind;
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
    clientHello: Record<string, unknown>;
    clientNonce: Uint8Array;
    clientSecretKey: Uint8Array;
    /**
     * How long direct routes race alone before the Relay joins; defaults to the full grace.
     */
    directGraceMs?: number;
    expectedServerId: string;
    mode: 'connect' | 'pair';
    presharedKey: Uint8Array;
    routes: MobileGatewayRoute[];
    runtime: MobileGatewayRuntime;
}): Promise<EstablishedSession> => {
    const graceMs = input.directGraceMs ?? DIRECT_ROUTE_GRACE_MS;
    const startedAt = Date.now();
    /**
     * A reconnect tells the Server how it got here, so its log can explain a slow reconnect from both ends.
     */
    const hello = (): string => {
        const trace: MobileConnectTrace = { graceMs, openMs: Date.now() - startedAt };
        return JSON.stringify(
            input.mode === 'connect' ? { ...input.clientHello, trace } : input.clientHello,
        );
    };
    // Only a reconnect hello may travel ahead on the Relay: it reserves nothing on the Server, while a pairing hello
    // consumes its pairing code and must reach only the route that wins.
    const opened = await openGatewaySocket(
        input.routes,
        input.runtime,
        graceMs,
        input.mode === 'connect' ? { relayHello: hello } : {},
    );
    const { route, socket } = opened;
    const reader = opened.reader ?? createSocketReader(socket);
    try {
        if (!opened.isHelloSent) socket.send(hello());
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
            route,
            runtime: input.runtime,
            socket,
        };
    } catch (error) {
        reader.close();
        socket.close();
        throw error;
    }
};
