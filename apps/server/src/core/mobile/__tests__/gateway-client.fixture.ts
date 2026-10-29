import { Buffer } from 'node:buffer';

import type { HandshakeTranscript } from '@caxri/mobile-transport';
import {
    decodeHex,
    deriveMobileSessionKeys,
    encodeHex,
    handshakeConfirmation,
    isHandshakeConfirmationValid,
    MOBILE_TRANSPORT_VERSION,
    mobileClientConfirmationSchema,
    mobilePublicKey,
    mobileSealedFrameSchema,
    mobileServerHelloSchema,
    openMobileFrame,
    sealMobileFrame,
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

export function nextMessage(socket: WebSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('message', (data) => {
            if (!Buffer.isBuffer(data)) {
                reject(new TypeError('Expected a buffered WebSocket message'));
                return;
            }
            resolve(JSON.parse(data.toString('utf8')) as unknown);
        });
    });
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
    mobileSealedFrameSchema.parse(await readyMessage);
    const received: unknown[] = [];
    const waiting: Array<(payload: unknown) => void> = [];
    socket.on('message', (data) => {
        if (!Buffer.isBuffer(data)) return;
        const frame = mobileSealedFrameSchema.parse(JSON.parse(data.toString('utf8')) as unknown);
        const plaintext = openMobileFrame(
            keys.serverToClient,
            {
                connectionId: transcript.connectionId,
                counter: frame.counter,
                deviceId: record.deviceId,
                direction: 'server-to-client',
            },
            decodeHex(frame.ciphertext),
        );
        const payload = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
        const reader = waiting.shift();
        if (reader) reader(payload);
        else received.push(payload);
    });
    let counter = 0;
    /**
     * `counterOverride` lets a replay-attack test resend an already-consumed counter deliberately.
     */
    const send = (request: unknown, counterOverride?: number): void => {
        const frameCounter = counterOverride ?? counter++;
        const ciphertext = sealMobileFrame(
            keys.clientToServer,
            {
                connectionId: transcript.connectionId,
                counter: frameCounter,
                deviceId: record.deviceId,
                direction: 'client-to-server',
            },
            new TextEncoder().encode(JSON.stringify(request)),
        );
        socket.send(
            JSON.stringify({
                type: 'sealed',
                version: MOBILE_TRANSPORT_VERSION,
                connectionId: challenge.connectionId,
                counter: frameCounter,
                ciphertext: encodeHex(ciphertext),
            }),
        );
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
