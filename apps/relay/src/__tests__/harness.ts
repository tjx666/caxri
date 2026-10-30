import { Buffer } from 'node:buffer';
import type { Socket } from 'node:net';

import type { RelayGrant } from '@caxri/mobile-transport';
import {
    createRelayHostKey,
    encodeHex,
    RELAY_PROTOCOL_VERSION,
    relayAccessKey,
    relayAccessKeyHash,
    relayEndpoint,
    relayPaths,
    signRelayHostChallenge,
} from '@caxri/mobile-transport';
import type { ClientOptions } from 'ws';
import WebSocket from 'ws';

import type { RelayConfig } from '../config';
import { defaultRelayConfig } from '../config';
import { RelayServer } from '../server';

export interface StartedRelay {
    baseUrl: string;
    lines: Array<Record<string, unknown>>;
    relay: RelayServer;
}

export const startRelay = async (overrides: Partial<RelayConfig> = {}): Promise<StartedRelay> => {
    const lines: Array<Record<string, unknown>> = [];
    const relay = new RelayServer(
        { ...defaultRelayConfig, host: '127.0.0.1', port: 0, ...overrides },
        { log: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const port = await relay.listen();
    return { baseUrl: `ws://127.0.0.1:${port}`, lines, relay };
};

/**
 * Reads text frames in order so a test can await the next one without racing the listener.
 */
export class FrameQueue {
    readonly #frames: unknown[] = [];
    readonly #waiters: Array<(frame: unknown) => void> = [];

    constructor(socket: WebSocket) {
        socket.on('message', (data, isBinary) => {
            const frame = isBinary
                ? data
                : (JSON.parse((data as Buffer).toString('utf8')) as unknown);
            const waiter = this.#waiters.shift();
            if (waiter) waiter(frame);
            else this.#frames.push(frame);
        });
    }

    next(): Promise<unknown> {
        const frame = this.#frames.shift();
        if (frame !== undefined) return Promise.resolve(frame);
        return new Promise((resolve) => this.#waiters.push(resolve));
    }
}

export const opened = (socket: WebSocket): Promise<void> =>
    new Promise((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });

export const closed = (socket: WebSocket): Promise<{ code: number; reason: string }> =>
    new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) resolve({ code: 1006, reason: '' });
        socket.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
    });

export const deviceAccess = (fill: number) => {
    const accessKey = relayAccessKey(new Uint8Array(32).fill(fill), 'device');
    return { accessKey: encodeHex(accessKey), keyHash: relayAccessKeyHash(accessKey) };
};

/**
 * A stand-in Server: registers with a fresh host key and, unless told otherwise, answers each `relay-incoming` by
 * dialing back and echoing every frame it receives.
 */
export class FakeHost {
    readonly #baseUrl: string;

    readonly key = createRelayHostKey();

    control!: WebSocket;

    hostId!: string;

    readonly dataSockets: WebSocket[] = [];

    incoming: Array<{ connectionId: string; ticket: string }> = [];

    dialBack = true;

    /**
     * The `relay-standby` ticket of a registration that asked for one.
     */
    standbyTicket?: string;

    constructor(baseUrl: string) {
        this.#baseUrl = baseUrl;
    }

    async #serve(frames: FrameQueue): Promise<void> {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- incoming frames are handled strictly in arrival order
            const frame = (await frames.next()) as {
                connectionId: string;
                ticket: string;
                type: string;
            };
            if (frame.type === 'relay-standby') {
                this.standbyTicket = frame.ticket;
                continue;
            }
            this.incoming.push(frame);
            if (this.dialBack) void this.accept(frame);
        }
    }

    async register(
        grants: RelayGrant[],
        secretKey = this.key.secretKey,
        options: { standby?: boolean } = {},
    ): Promise<void> {
        this.control = new WebSocket(relayEndpoint(this.#baseUrl, relayPaths.host));
        const frames = new FrameQueue(this.control);
        await opened(this.control);
        const challenge = (await frames.next()) as { nonce: string };
        const signature = signRelayHostChallenge(secretKey, Buffer.from(challenge.nonce, 'hex'));
        this.control.send(
            JSON.stringify({
                type: 'host-register',
                version: RELAY_PROTOCOL_VERSION,
                publicKey: encodeHex(this.key.publicKey),
                signature: encodeHex(signature),
                grants,
                ...(options.standby && { standby: true }),
            }),
        );
        const registered = (await frames.next()) as { hostId: string };
        this.hostId = registered.hostId;
        if (options.standby)
            this.standbyTicket = ((await frames.next()) as { ticket: string }).ticket;
        void this.#serve(frames);
    }

    updateGrants(add: RelayGrant[], remove: string[]): void {
        this.control.send(JSON.stringify({ type: 'grant-update', add, remove }));
    }

    async accept(
        incoming: { connectionId: string; ticket: string },
        hostId = this.hostId,
    ): Promise<WebSocket> {
        const socket = new WebSocket(relayEndpoint(this.#baseUrl, relayPaths.hostData));
        await opened(socket);
        socket.send(
            JSON.stringify({
                type: 'host-accept',
                version: RELAY_PROTOCOL_VERSION,
                hostId,
                connectionId: incoming.connectionId,
                ticket: incoming.ticket,
            }),
        );
        socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
        this.dataSockets.push(socket);
        return socket;
    }
}

/**
 * Parks an idle host-data socket. Once the Relay sends `relay-spliced`, it echoes every later frame like a dial-back.
 */
export const parkStandby = async (
    baseUrl: string,
    host: FakeHost,
    ticket = host.standbyTicket!,
): Promise<{ socket: WebSocket; frames: FrameQueue }> => {
    const socket = new WebSocket(relayEndpoint(baseUrl, relayPaths.hostData));
    const frames = new FrameQueue(socket);
    await opened(socket);
    socket.send(
        JSON.stringify({
            type: 'host-standby',
            version: RELAY_PROTOCOL_VERSION,
            hostId: host.hostId,
            ticket,
        }),
    );
    return { socket, frames };
};

export const connectClient = async (
    baseUrl: string,
    hostId: string,
    accessKey: string,
    options?: ClientOptions,
    earlyFrames: string[] = [],
): Promise<{ socket: WebSocket; frames: FrameQueue }> => {
    const socket = new WebSocket(relayEndpoint(baseUrl, relayPaths.client), options);
    const frames = new FrameQueue(socket);
    await opened(socket);
    // Corked so `relay-connect` and any early frames leave in one TCP write, as a phone's hello can arrive in the same
    // read as its `relay-connect`. `_socket` is ws's underlying net socket.
    const transport = (socket as unknown as { _socket: Socket })._socket;
    transport.cork();
    socket.send(
        JSON.stringify({
            type: 'relay-connect',
            version: RELAY_PROTOCOL_VERSION,
            hostId,
            accessKey,
        }),
    );
    for (const frame of earlyFrames) socket.send(frame);
    transport.uncork();
    return { socket, frames };
};

export const waitFor = async (isDone: () => boolean, timeoutMs = 3_000): Promise<void> => {
    const startedAt = Date.now();
    while (!isDone()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition');
        // eslint-disable-next-line no-await-in-loop -- polling must observe each state before the next check
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};
