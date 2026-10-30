import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';

import {
    decodeHex,
    isRelayHostProofValid,
    RELAY_CHALLENGE_BYTES,
    RELAY_PROTOCOL_VERSION,
    RELAY_TICKET_BYTES,
    relayChallengeSchema,
    relayCloseCodes,
    relayGrantUpdateSchema,
    relayHostIdForPublicKey,
    relayHostRegisteredSchema,
    relayHostRegisterSchema,
    relayPaths,
    relayStandbySchema,
} from '@caxri/mobile-transport';
import type { RawData } from 'ws';
import WebSocket, { WebSocketServer } from 'ws';

import { sourceAddress, SourceAdmission } from './admission';
import type { RelayConfig } from './config';
import type { RegisteredHost } from './hosts';
import { HostRegistry } from './hosts';
import type { RelayEndCause, RelayLogSink, RelayRejection } from './log';
import { RelayLogger, shortHostId } from './log';
import { Rendezvous } from './rendezvous';
import type { Splice } from './splice';

type Route = 'client' | 'host' | 'hostData';

const SWEEP_INTERVAL_MS = 1_000;
const SHUTDOWN_GRACE_MS = 1_000;

interface SocketState {
    route: Route;
    source: string;
    missedPongs: number;
    /**
     * Whether this socket still holds a pre-authentication slot for its source address.
     */
    holdsSourceSlot: boolean;
    endCause?: RelayEndCause;
}

export interface RelayStats {
    hosts: number;
    connections: number;
    /**
     * Idle host-data sockets parked for the next phone.
     */
    standbys: number;
}

const rejectionCodes: Record<RelayRejection, number> = {
    'capacity': relayCloseCodes.capacity,
    'host-offline': relayCloseCodes['host-offline'],
    'host-timeout': relayCloseCodes['host-timeout'],
    'invalid-request': relayCloseCodes['invalid-request'],
    'not-found': relayCloseCodes['invalid-request'],
    'rate-limited': relayCloseCodes['rate-limited'],
    'source-pending': relayCloseCodes['rate-limited'],
    'unauthorized': relayCloseCodes.unauthorized,
};

/**
 * Node's parser accepts absolute-form targets such as `http://%zz/`, which `new URL` rejects; an unparsable target is
 * an unknown route, never an exception that would take the process down.
 */
const requestPath = (request: IncomingMessage): string | undefined => {
    try {
        return new URL(request.url ?? '/', 'http://relay').pathname;
    } catch {
        return undefined;
    }
};

const parseText = (data: RawData, isBinary: boolean): unknown => {
    if (isBinary) throw new Error('Expected a text frame');
    const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
    return JSON.parse(text) as unknown;
};

/**
 * One Relay process. It never parses anything after a connection's first frame: once spliced, bytes flow between the
 * phone and the Server's dial-back socket untouched, so the end-to-end encrypted gateway handshake runs through it.
 */
export class RelayServer {
    readonly #config: RelayConfig;
    readonly #logger: RelayLogger;
    readonly #now: () => number;
    readonly #random: (bytes: number) => Buffer;
    readonly #registry: HostRegistry;
    readonly #admission: SourceAdmission;
    readonly #rendezvous: Rendezvous;
    readonly #sockets = new Map<WebSocket, SocketState>();
    readonly #webSocketServer: WebSocketServer;
    readonly #server: Server;
    #timers: Array<ReturnType<typeof setInterval>> = [];
    #closing = false;

    constructor(
        config: RelayConfig,
        options: { log: RelayLogSink; now?: () => number; random?: (bytes: number) => Buffer },
    ) {
        this.#config = config;
        this.#now = options.now ?? Date.now;
        this.#random = options.random ?? randomBytes;
        this.#logger = new RelayLogger(options.log, this.#now);
        this.#registry = new HostRegistry(this.#now);
        this.#admission = new SourceAdmission({
            attemptsPerMinute: config.sourceAttemptsPerMinute,
            pendingLimit: config.sourcePendingSockets,
            now: this.#now,
        });
        this.#rendezvous = new Rendezvous({
            config,
            endCauseOf: (socket) => {
                const state = this.#sockets.get(socket);
                return state && (() => state.endCause);
            },
            logger: this.#logger,
            now: this.#now,
            random: this.#random,
            registry: this.#registry,
            reject: (socket, reason) => this.#reject(socket, reason),
        });
        this.#webSocketServer = new WebSocketServer({
            noServer: true,
            maxPayload: config.maxPayloadBytes,
            perMessageDeflate: false,
        });
        this.#server = createServer((request, response) => this.#handleHttp(request, response));
        this.#server.on('upgrade', (request, socket, head) =>
            this.#handleUpgrade(request, socket, head),
        );
    }

    #routeOf(pathname: string | undefined): Route | 'health' | undefined {
        if (pathname === undefined) return undefined;
        const { basePath } = this.#config;
        if (basePath && !pathname.startsWith(`${basePath}/`)) return undefined;
        switch (pathname.slice(basePath.length)) {
            case relayPaths.client:
                return 'client';
            case relayPaths.host:
                return 'host';
            case relayPaths.hostData:
                return 'hostData';
            case relayPaths.health:
                return 'health';
            default:
                return undefined;
        }
    }

    #handleHttp(request: IncomingMessage, response: ServerResponse): void {
        if (request.method === 'GET' && this.#routeOf(requestPath(request)) === 'health') {
            response.writeHead(this.#closing ? 503 : 200, { 'content-type': 'application/json' });
            response.end(
                JSON.stringify({
                    status: this.#closing ? 'shutting-down' : 'ok',
                    protocolVersion: RELAY_PROTOCOL_VERSION,
                    ...this.stats(),
                }),
            );
            return;
        }
        response.writeHead(404, { connection: 'close' }).end();
    }

    #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
        const route = this.#routeOf(requestPath(request));
        const refuse = (status: number, reason: RelayRejection): void => {
            this.#rejected(route ?? 'unknown', reason);
            socket.end(
                `HTTP/1.1 ${status} ${status === 429 ? 'Too Many Requests' : 'Refused'}\r\n\r\n`,
            );
            socket.destroy();
        };
        if (!route || route === 'health') {
            refuse(404, 'not-found');
            return;
        }
        if (this.#closing) {
            refuse(503, 'capacity');
            return;
        }
        const source = sourceAddress(request, this.#config.trustProxy);
        // Host dial-backs are bounded by single-use tickets, so they skip the attempt window but still hold a slot.
        const refusal = this.#admission.admit(source, route !== 'hostData');
        if (refusal) {
            refuse(429, refusal);
            return;
        }
        this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
            this.#accept(webSocket, route, source),
        );
    }

    #accept(socket: WebSocket, route: Route, source: string): void {
        const state: SocketState = { route, source, missedPongs: 0, holdsSourceSlot: true };
        this.#sockets.set(socket, state);
        const deadline = setTimeout(
            () => this.#reject(socket, 'invalid-request'),
            this.#config.firstFrameTimeoutMs,
        );
        deadline.unref();
        socket.on('pong', () => (state.missedPongs = 0));
        socket.on('error', () => {});
        socket.on('close', () => {
            clearTimeout(deadline);
            this.#releaseSource(state);
            this.#sockets.delete(socket);
        });
        const authenticated = (): void => {
            clearTimeout(deadline);
            this.#releaseSource(state);
        };
        if (route === 'host') {
            this.#acceptHost(socket, state, authenticated);
            return;
        }
        socket.once('message', (data, isBinary) => {
            try {
                const frame = parseText(data, isBinary);
                if (route === 'client') this.#rendezvous.acceptClient(socket, frame, authenticated);
                else this.#rendezvous.acceptHostData(socket, frame, authenticated);
            } catch {
                this.#reject(socket, 'invalid-request');
            }
        });
    }

    #acceptHost(socket: WebSocket, state: SocketState, authenticated: () => void): void {
        const nonce = this.#random(RELAY_CHALLENGE_BYTES);
        const challenge = relayChallengeSchema.parse({
            type: 'relay-challenge',
            version: RELAY_PROTOCOL_VERSION,
            nonce: nonce.toString('hex'),
        });
        socket.send(JSON.stringify(challenge));
        let host: RegisteredHost | undefined;
        socket.on('message', (data, isBinary) => {
            try {
                const frame = parseText(data, isBinary);
                if (host) {
                    const update = relayGrantUpdateSchema.parse(frame);
                    const revoked = this.#registry.applyGrants(host, update.add, update.remove);
                    for (const splice of revoked)
                        splice.close('revoked', relayCloseCodes.unauthorized);
                    this.#logger.count('grantUpdates');
                    return;
                }
                const register = relayHostRegisterSchema.parse(frame);
                const publicKey = decodeHex(register.publicKey);
                if (
                    !isRelayHostProofValid({
                        challenge: nonce,
                        publicKey,
                        signature: decodeHex(register.signature),
                    })
                ) {
                    this.#reject(socket, 'unauthorized');
                    return;
                }
                const hostId = relayHostIdForPublicKey(publicKey);
                if (
                    !this.#registry.host(hostId) &&
                    this.#registry.hostCount >= this.#config.maxHosts
                ) {
                    this.#reject(socket, 'capacity');
                    return;
                }
                authenticated();
                const replacedStandby = this.#registry.host(hostId)?.standby;
                const replaced = this.#registry.register(hostId, socket, register.grants);
                host = this.#registry.host(hostId);
                replacedStandby?.socket.close(relayCloseCodes.replaced);
                if (replaced) {
                    const replacedState = this.#sockets.get(replaced);
                    if (replacedState) replacedState.endCause = 'replaced';
                    replaced.close(relayCloseCodes.replaced);
                }
                socket.send(
                    JSON.stringify(
                        relayHostRegisteredSchema.parse({
                            type: 'host-registered',
                            version: RELAY_PROTOCOL_VERSION,
                            hostId,
                        }),
                    ),
                );
                if (host && register.standby) {
                    host.standbyTicket = this.#random(RELAY_TICKET_BYTES);
                    const standby = relayStandbySchema.parse({
                        type: 'relay-standby',
                        ticket: host.standbyTicket.toString('hex'),
                    });
                    socket.send(JSON.stringify(standby));
                }
                const registeredAt = this.#now();
                this.#logger.count('hostsRegistered');
                this.#logger.write({
                    event: 'relay.host_registered',
                    host: shortHostId(hostId),
                    grants: register.grants.length,
                    replaced: Boolean(replaced),
                    standby: Boolean(register.standby),
                });
                const registered = host;
                socket.once('close', () => {
                    if (this.#registry.host(hostId) === registered)
                        registered?.standby?.socket.close(relayCloseCodes['host-offline']);
                    const dropped = this.#registry.unregister(hostId, socket);
                    for (const item of dropped) {
                        item.client.resume();
                        item.client.close(relayCloseCodes['host-offline']);
                    }
                    this.#logger.write({
                        event: 'relay.host_ended',
                        host: shortHostId(hostId),
                        cause: state.endCause ?? 'host-closed',
                        durationMs: this.#now() - registeredAt,
                        droppedPending: dropped.length,
                    });
                });
            } catch {
                this.#reject(socket, 'invalid-request');
            }
        });
    }

    #releaseSource(state: SocketState): void {
        if (!state.holdsSourceSlot) return;
        state.holdsSourceSlot = false;
        this.#admission.release(state.source);
    }

    #rejected(route: string, reason: RelayRejection): void {
        this.#logger.count(`rejected.${reason}`);
        this.#logger.write({ event: 'relay.rejected', route, reason });
    }

    #reject(socket: WebSocket, reason: RelayRejection): void {
        this.#rejected(this.#sockets.get(socket)?.route ?? 'unknown', reason);
        if (socket.readyState === WebSocket.OPEN) socket.close(rejectionCodes[reason]);
        else socket.terminate();
    }

    /**
     * Pings every socket. Mobile carriers, notably in mainland China, drop idle NAT mappings within minutes, so the
     * Relay keeps traffic flowing and terminates a socket after consecutive unanswered pings.
     */
    #heartbeat(): void {
        for (const [socket, state] of this.#sockets) {
            if (state.missedPongs >= this.#config.heartbeatMissLimit) {
                state.endCause ??= 'heartbeat-timeout';
                this.#logger.count('heartbeatTimeouts');
                socket.terminate();
                continue;
            }
            state.missedPongs += 1;
            if (socket.readyState === WebSocket.OPEN) socket.ping();
        }
    }

    /**
     * Enforces the process-wide buffer cap by ending the single largest offender, then ages out rate-limit windows and
     * expired pairing grants.
     */
    #sweep(): void {
        const splices = this.#registry.splices();
        let total = 0;
        let largest: Splice | undefined;
        for (const splice of splices) {
            total += splice.bufferedAmount;
            if (!largest || splice.bufferedAmount > largest.bufferedAmount) largest = splice;
        }
        if (largest && total > this.#config.maxProcessBufferedBytes)
            largest.close('capacity', relayCloseCodes.capacity);
        this.#admission.sweep();
        this.#registry.sweepExpiredGrants();
    }

    stats(): RelayStats {
        return {
            hosts: this.#registry.hostCount,
            connections: this.#registry.connectionCount,
            standbys: this.#registry.standbyCount,
        };
    }

    async listen(): Promise<number> {
        await new Promise<void>((resolve, reject) => {
            this.#server.once('error', reject);
            this.#server.listen(this.#config.port, this.#config.host, () => {
                this.#server.off('error', reject);
                resolve();
            });
        });
        const timers = [
            setInterval(() => this.#heartbeat(), this.#config.heartbeatIntervalMs),
            setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS),
            setInterval(
                () => this.#logger.summary({ ...this.stats() }),
                this.#config.summaryIntervalMs,
            ),
        ];
        for (const timer of timers) timer.unref();
        this.#timers = timers;
        const address = this.#server.address();
        if (!address || typeof address === 'string') throw new Error('Relay has no TCP address');
        return address.port;
    }

    /**
     * Ends every socket with `shutting-down` so Servers and phones reconnect after backoff, then stops listening.
     */
    async close(): Promise<void> {
        this.#closing = true;
        for (const timer of this.#timers) clearInterval(timer);
        this.#timers = [];
        const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
        for (const [socket, state] of this.#sockets) {
            state.endCause ??= 'shutting-down';
            if (socket.isPaused) socket.resume();
            if (socket.readyState === WebSocket.OPEN)
                socket.close(relayCloseCodes['shutting-down']);
        }
        await new Promise<void>((resolve) => {
            const deadline = setTimeout(resolve, SHUTDOWN_GRACE_MS);
            const check = setInterval(() => {
                if (this.#sockets.size > 0) {
                    return;
                }

                clearInterval(check);
                clearTimeout(deadline);
                resolve();
            }, 20);
        });
        for (const socket of this.#sockets.keys()) socket.terminate();
        this.#webSocketServer.close();
        this.#logger.summary({ ...this.stats() });
        await closed;
    }
}
