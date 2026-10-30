import { Buffer } from 'node:buffer';

import type { RelayHostAccept, RelayHostStandby } from '@caxri/mobile-transport';
import {
    RELAY_CONNECTION_ID_BYTES,
    RELAY_PROTOCOL_VERSION,
    RELAY_TICKET_BYTES,
    relayAccessKeyHashFromHex,
    relayClientConnectSchema,
    relayClientReadySchema,
    relayCloseCodes,
    relayHostDataFirstFrameSchema,
    relayIncomingSchema,
    relayStandbySplicedSchema,
} from '@caxri/mobile-transport';
import type { RawData } from 'ws';
import WebSocket from 'ws';

import type { RelayConfig } from './config';
import type { EarlyFrame, HostRegistry } from './hosts';
import type { RelayEndCause, RelayLogger, RelayRejection } from './log';
import { shortHostId } from './log';
import { rawByteLength, Splice } from './splice';

/**
 * Frames a phone may send between `relay-connect` and its splice: the gateway hello, plus slack for a client that
 * pipelines more. Anything beyond is not a well-behaved phone.
 */
const MAX_EARLY_FRAMES = 4;

export interface RendezvousDependencies {
    config: RelayConfig;
    /**
     * Returns a reader for the cause the Relay records against a socket before closing it. Read lazily, because the
     * Relay forgets a socket's state as soon as it closes.
     */
    endCauseOf: (socket: WebSocket) => (() => RelayEndCause | undefined) | undefined;
    logger: RelayLogger;
    now: () => number;
    random: (bytes: number) => Buffer;
    registry: HostRegistry;
    reject: (socket: WebSocket, reason: RelayRejection) => void;
}

/**
 * Brings a phone and its computer together after each has authenticated: holds the phone's early frames, splices it to
 * a parked standby socket or asks the computer to dial back, and starts the byte splice.
 */
export class Rendezvous {
    readonly #deps: RendezvousDependencies;

    constructor(dependencies: RendezvousDependencies) {
        this.#deps = dependencies;
    }

    /**
     * The phone sends its gateway hello right after `relay-connect`, before a splice exists. Pausing stops further
     * reads, but `ws` still emits frames already parsed from the same TCP read, so they are held here until the splice
     * forwards them ahead of everything else.
     */
    #holdEarlyFrames(socket: WebSocket): () => EarlyFrame[] {
        socket.pause();
        const frames: EarlyFrame[] = [];
        let bytes = 0;
        const hold = (data: RawData, isBinary: boolean): void => {
            bytes += rawByteLength(data);
            if (frames.length >= MAX_EARLY_FRAMES || bytes > this.#deps.config.maxPayloadBytes) {
                this.#deps.reject(socket, 'invalid-request');
                return;
            }
            frames.push({ data, isBinary });
        };
        socket.on('message', hold);
        return () => {
            socket.off('message', hold);
            return frames;
        };
    }

    #acceptDialBack(socket: WebSocket, accept: RelayHostAccept, authenticated: () => void): void {
        const pending = this.#deps.registry.claim(
            accept.connectionId,
            accept.hostId,
            Buffer.from(accept.ticket, 'hex'),
        );
        if (!pending) {
            this.#deps.reject(socket, 'unauthorized');
            return;
        }
        authenticated();
        const { client } = pending;
        if (client.readyState !== WebSocket.OPEN) {
            socket.close(relayCloseCodes['peer-gone']);
            return;
        }
        this.#splice({
            client,
            hostSocket: socket,
            hostId: pending.hostId,
            keyHash: pending.keyHash,
            startedAt: pending.startedAt,
            earlyFrames: pending.takeEarlyFrames(),
            isStandby: false,
        });
    }

    /**
     * Keeps a Server's idle host-data socket for the next phone. Nothing may arrive on it until it is spliced.
     */
    #parkStandby(socket: WebSocket, standby: RelayHostStandby, authenticated: () => void): void {
        const host = this.#deps.registry.host(standby.hostId);
        if (
            !host ||
            !this.#deps.registry.isStandbyTicketValid(host, Buffer.from(standby.ticket, 'hex'))
        ) {
            this.#deps.reject(socket, 'unauthorized');
            return;
        }
        authenticated();
        const onMessage = (): void => this.#deps.reject(socket, 'invalid-request');
        const onClose = (): void => this.#deps.registry.forgetStandby(standby.hostId, socket);
        socket.on('message', onMessage);
        socket.once('close', onClose);
        const replaced = this.#deps.registry.park(host, {
            socket,
            release: () => {
                socket.off('message', onMessage);
                socket.off('close', onClose);
            },
        });
        replaced?.socket.close(relayCloseCodes.replaced);
        this.#deps.logger.count('standbyParked');
    }

    #splice(input: {
        client: WebSocket;
        hostSocket: WebSocket;
        hostId: string;
        keyHash: string;
        startedAt: number;
        earlyFrames: EarlyFrame[];
        isStandby: boolean;
    }): void {
        const { client, hostSocket } = input;
        // The parked socket learns it is live before any phone frame reaches it.
        if (input.isStandby)
            hostSocket.send(
                JSON.stringify(
                    relayStandbySplicedSchema.parse({
                        type: 'relay-spliced',
                        version: RELAY_PROTOCOL_VERSION,
                    }),
                ),
            );
        client.send(
            JSON.stringify(
                relayClientReadySchema.parse({
                    type: 'relay-ready',
                    version: RELAY_PROTOCOL_VERSION,
                }),
            ),
        );
        for (const early of input.earlyFrames)
            hostSocket.send(early.data, { binary: early.isBinary });
        const host = shortHostId(input.hostId);
        // Captured now: the socket close handler forgets each state before the Splice sees the close.
        const states = new Map([
            [client, this.#deps.endCauseOf(client)],
            [hostSocket, this.#deps.endCauseOf(hostSocket)],
        ]);
        const splice = new Splice({
            client,
            host: hostSocket,
            hostId: input.hostId,
            keyHash: input.keyHash,
            limits: this.#deps.config,
            now: this.#deps.now,
            recordedCause: (ended) => states.get(ended)?.(),
            onEnd: (end) => {
                this.#deps.registry.removeSplice(splice);
                this.#deps.logger.count('connectionsEnded');
                this.#deps.logger.write({ event: 'relay.connection_ended', host, ...end });
            },
        });
        this.#deps.registry.addSplice(splice);
        client.resume();
        this.#deps.logger.count('connectionsSpliced');
        if (input.isStandby) this.#deps.logger.count('standbySpliced');
        this.#deps.logger.write({
            event: 'relay.connection_spliced',
            host,
            setupMs: this.#deps.now() - input.startedAt,
            standby: input.isStandby,
            earlyFrames: input.earlyFrames.length,
        });
    }

    acceptClient(socket: WebSocket, frame: unknown, authenticated: () => void): void {
        const connect = relayClientConnectSchema.parse(frame);
        const host = this.#deps.registry.host(connect.hostId);
        if (!host) {
            this.#deps.reject(socket, 'host-offline');
            return;
        }
        const keyHash = relayAccessKeyHashFromHex(connect.accessKey);
        if (!this.#deps.registry.hasGrant(host, keyHash)) {
            this.#deps.reject(socket, 'unauthorized');
            return;
        }
        if (
            this.#deps.registry.hostConnectionCount(host.hostId) >=
            this.#deps.config.maxConnectionsPerHost
        ) {
            this.#deps.reject(socket, 'capacity');
            return;
        }
        authenticated();
        const startedAt = this.#deps.now();
        const takeEarlyFrames = this.#holdEarlyFrames(socket);
        const standby = this.#deps.registry.takeStandby(host);
        if (standby?.socket.readyState === WebSocket.OPEN) {
            standby.release();
            this.#splice({
                client: socket,
                hostSocket: standby.socket,
                hostId: host.hostId,
                keyHash,
                startedAt,
                earlyFrames: takeEarlyFrames(),
                isStandby: true,
            });
            return;
        }
        const connectionId = this.#deps.random(RELAY_CONNECTION_ID_BYTES).toString('hex');
        const ticket = this.#deps.random(RELAY_TICKET_BYTES);
        const timer = setTimeout(() => {
            if (!this.#deps.registry.takePending(connectionId)) return;
            takeEarlyFrames();
            socket.resume();
            this.#deps.reject(socket, 'host-timeout');
        }, this.#deps.config.hostDialTimeoutMs);
        timer.unref();
        this.#deps.registry.addPending({
            client: socket,
            connectionId,
            hostId: host.hostId,
            keyHash,
            startedAt,
            takeEarlyFrames,
            ticket,
            timer,
        });
        socket.once('close', () => this.#deps.registry.takePending(connectionId));
        const incoming = relayIncomingSchema.parse({
            type: 'relay-incoming',
            connectionId,
            ticket: ticket.toString('hex'),
        });
        host.control.send(JSON.stringify(incoming));
    }

    acceptHostData(socket: WebSocket, frame: unknown, authenticated: () => void): void {
        const first = relayHostDataFirstFrameSchema.parse(frame);
        if (first.type === 'host-standby') this.#parkStandby(socket, first, authenticated);
        else this.#acceptDialBack(socket, first, authenticated);
    }
}
