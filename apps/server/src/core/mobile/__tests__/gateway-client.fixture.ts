import { Buffer } from 'node:buffer';

import type { HandshakeTranscript, MobileSessionKeys } from '@caxri/mobile-transport';
import {
    decodeHex,
    decodeSealedFrame,
    deriveMobileSessionKeys,
    encodeHex,
    handshakeConfirmation,
    isHandshakeConfirmationValid,
    MOBILE_TRANSPORT_VERSION,
    mobileClientConfirmationSchema,
    mobilePublicKey,
    mobileServerHelloSchema,
    openMobilePayload,
    sealMobilePayload,
} from '@caxri/mobile-transport';
import type { Principal } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { expect } from 'vitest';
import type { ClientOptions } from 'ws';
import WebSocket from 'ws';

import { createMemoryMobileDeviceStore } from '../../__tests__/credential-stores.fixture';
import type { MobileDeviceRecord } from '../device-registry';
import { MobileDeviceRegistry } from '../device-registry';
import type { MobileGateway } from '../gateway';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';

/**
 * Creates an isolated in-memory device registry for a single test.
 */
export function registryFixture() {
    let byte = 1;
    return MobileDeviceRegistry.open({
        store: createMemoryMobileDeviceStore(),
        now: () => 1_788_106_000_000 + byte,
        random: (bytes) => new Uint8Array(bytes).fill(byte++),
    });
}

export function authorizeMethod(principal: Principal, method: string): void {
    if (
        principal.kind !== 'paired-device' ||
        !isMobileGatewayMethodAllowedForRole(principal.role, method)
    )
        throw new CaxriError('FORBIDDEN', 'Paired device role does not allow this method');
}

export const subscriptionOptions = {
    authorizeSubscription: () => Promise.resolve(),
    matchesSubscriptionEvent: () => Promise.resolve(true),
};

/**
 * Resolves with the next message: parsed JSON for a text frame, the raw bytes for a binary sealed frame.
 */
export function nextMessage(socket: WebSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('message', (data, isBinary) => {
            if (!Buffer.isBuffer(data)) {
                reject(new TypeError('Expected a buffered WebSocket message'));
                return;
            }
            resolve(
                isBinary ? new Uint8Array(data) : (JSON.parse(data.toString('utf8')) as unknown),
            );
        });
    });
}

/**
 * The phone's side of an authenticated connection, enough to open and seal frames the way it does.
 */
export interface SealedPeer {
    connectionId: Uint8Array;
    deviceId: string;
    keys: MobileSessionKeys;
}

/**
 * Opens one binary server-to-client frame and returns its payload.
 */
export function openServerFrame(peer: SealedPeer, message: unknown): unknown {
    if (!(message instanceof Uint8Array)) throw new TypeError('Expected a binary sealed frame');
    const { ciphertext, counter } = decodeSealedFrame(message);
    return openMobilePayload(
        peer.keys.serverToClient,
        {
            connectionId: peer.connectionId,
            counter,
            deviceId: peer.deviceId,
            direction: 'server-to-client',
        },
        ciphertext,
    );
}

/**
 * Seals one client-to-server payload as the binary frame for `counter`.
 */
export function sealClientFrame(peer: SealedPeer, counter: number, payload: unknown): Uint8Array {
    return sealMobilePayload(
        peer.keys.clientToServer,
        {
            connectionId: peer.connectionId,
            counter,
            deviceId: peer.deviceId,
            direction: 'client-to-server',
        },
        payload,
    );
}

export function openSocket(url: string, options?: ClientOptions) {
    const socket = new WebSocket(url, options);
    return new Promise<WebSocket>((resolve, reject) => {
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
    });
}

/**
 * Opens a phone socket on the gateway's LAN listener; Relay tests pass their own opener instead.
 */
async function openLanSocket(gateway: MobileGateway): Promise<WebSocket> {
    const enabled = await gateway.enable();
    return openSocket(`ws://${enabled.address}:${enabled.port}/mobile`);
}

export async function connectDevice(
    gateway: MobileGateway,
    record: Pick<MobileDeviceRecord, 'credential' | 'deviceId' | 'generation'>,
    open: (gateway: MobileGateway) => Promise<WebSocket> = openLanSocket,
) {
    const socket = await open(gateway);
    const clientSecret = decodeHex('21'.repeat(32));
    const clientPublicKey = mobilePublicKey(clientSecret);
    const clientNonce = decodeHex('31'.repeat(32));
    const challengeMessage = nextMessage(socket);
    socket.send(
        JSON.stringify({
            type: 'hello',
            version: MOBILE_TRANSPORT_VERSION,
            mode: 'connect',
            deviceId: record.deviceId,
            generation: record.generation,
            clientPublicKey: encodeHex(clientPublicKey),
            clientNonce: encodeHex(clientNonce),
        }),
    );
    const challenge = mobileServerHelloSchema.parse(await challengeMessage);
    const transcript: HandshakeTranscript = {
        mode: 'connect',
        serverId: 'a'.repeat(32),
        principalId: `paired-device:${record.deviceId}`,
        connectionId: decodeHex(challenge.connectionId, 16),
        clientPublicKey,
        serverPublicKey: decodeHex(challenge.serverPublicKey, 32),
        clientNonce,
        serverNonce: decodeHex(challenge.serverNonce, 32),
    };
    const keys = deriveMobileSessionKeys({
        localSecretKey: clientSecret,
        peerPublicKey: transcript.serverPublicKey,
        presharedKey: decodeHex(record.credential, 32),
        transcript,
    });
    expect(
        isHandshakeConfirmationValid(decodeHex(challenge.confirmation, 32), keys, 'server'),
    ).toBe(true);
    const readyMessage = nextMessage(socket);
    const confirmation = encodeHex(handshakeConfirmation(keys, 'client'));
    socket.send(
        JSON.stringify(
            mobileClientConfirmationSchema.parse({
                type: 'confirm',
                version: MOBILE_TRANSPORT_VERSION,
                connectionId: challenge.connectionId,
                confirmation,
            }),
        ),
    );
    const peer: SealedPeer = {
        connectionId: transcript.connectionId,
        deviceId: record.deviceId,
        keys,
    };
    openServerFrame(peer, await readyMessage);
    const received: unknown[] = [];
    const waiting: Array<(payload: unknown) => void> = [];
    socket.on('message', (data, isBinary) => {
        if (!isBinary || !Buffer.isBuffer(data)) return;
        const payload = openServerFrame(peer, new Uint8Array(data));
        const reader = waiting.shift();
        if (reader) reader(payload);
        else received.push(payload);
    });
    let counter = 0;
    /**
     * `counterOverride` lets a replay-attack test resend an already-consumed counter deliberately.
     */
    const send = (request: unknown, counterOverride?: number): void => {
        socket.send(sealClientFrame(peer, counterOverride ?? counter++, request));
    };
    const read = (): Promise<unknown> => {
        if (received.length > 0) return Promise.resolve(received.shift());
        return new Promise((resolve) => waiting.push(resolve));
    };
    return {
        socket,
        connectionId: challenge.connectionId,
        request: async (request: unknown): Promise<unknown> => {
            const replyMessage = read();
            send({ type: 'request', request });
            const payload = (await replyMessage) as {
                type: string;
                reply: unknown;
            };
            expect(payload.type).toBe('reply');
            return payload.reply;
        },
        read,
        send,
    };
}
