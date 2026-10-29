import type { RelayCloseReason, RelayGrant } from '@caxri/mobile-transport';
import {
    decodeHex,
    encodeHex,
    MOBILE_GATEWAY_MAX_WIRE_BYTES,
    RELAY_CHALLENGE_BYTES,
    RELAY_MAX_GRANTS,
    RELAY_PROTOCOL_VERSION,
    relayChallengeSchema,
    relayCloseReasonOf,
    relayEndpoint,
    relayHostAcceptSchema,
    relayHostIdForPublicKey,
    relayHostPublicKey,
    relayHostRegisteredSchema,
    relayHostRegisterSchema,
    relayIncomingSchema,
    relayPaths,
    signRelayHostChallenge,
} from '@caxri/mobile-transport';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import WebSocket from 'ws';

import { messageText } from '../gateway/socket-message';

export type RelayConnectorState = 'connecting' | 'offline' | 'online' | 'stopped';

/**
 * Why the Relay registration changed state. Closed so a log reader can count outcomes without parsing text.
 */
export type RelayStateCause =
    | 'closed-by-relay'
    | 'disabled'
    | 'heartbeat-timeout'
    | 'network-error'
    | 'protocol-error'
    | 'registered'
    | 'registration-rejected'
    | 'started';

export type RelayDialFailure = 'accept-rejected' | 'capacity' | 'dial-failed';

export interface RelayConnectorTiming {
    initialBackoffMs: number;
    maxBackoffMs: number;
    /**
     * A registration that survives this long resets the backoff, so one flap after hours online retries quickly.
     */
    stableAfterMs: number;
    pingIntervalMs: number;
    pongTimeoutMs: number;
    /**
     * Bound for the host-data dial-back; the Relay itself gives up on a waiting phone after its own ticket timeout.
     */
    dialTimeoutMs: number;
}

const defaultRelayConnectorTiming: RelayConnectorTiming = {
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    stableAfterMs: 30_000,
    pingIntervalMs: 20_000,
    pongTimeoutMs: 45_000,
    dialTimeoutMs: 10_000,
};

export interface RelayHostConnectorOptions {
    url: string;
    secretKey: Uint8Array;
    grants: () => RelayGrant[];
    /**
     * Whether the gateway can take another connection; checked before dialing back so a full gateway refuses early.
     */
    canAccept: () => boolean;
    /**
     * Receives the spliced host-data socket synchronously after `host-accept` is written, so its listeners are attached
     * before the first phone frame can arrive.
     */
    onConnection: (socket: WebSocket) => void;
    logger?: Pick<StructuredLogger, 'write'>;
    now?: () => number;
    random?: () => number;
    timing?: Partial<RelayConnectorTiming>;
    /**
     * Test seam; production dials with `ws`.
     */
    createWebSocket?: (url: string) => WebSocket;
}

const wireOptions = { maxPayload: MOBILE_GATEWAY_MAX_WIRE_BYTES, perMessageDeflate: false };

const grantList = (grants: Map<string, number | undefined>): RelayGrant[] =>
    [...grants].map(([keyHash, expiresAt]) => ({
        keyHash,
        ...(expiresAt !== undefined && { expiresAt }),
    }));

/**
 * Keeps one outbound control registration with a Caxri Relay and dials back for each phone the Relay admits. The Relay
 * never sees the gateway handshake: a dialed-back socket enters the same encrypted pipeline as a LAN socket.
 *
 * Lifecycle: `start()` connects and reconnects with jittered exponential backoff until `stop()`. Grants are sent in
 * full with every registration and as diffs while registered, so a Relay restart converges without extra state.
 */
/* eslint-disable unicorn/consistent-class-member-order -- The public lifecycle API stays together before internals. */
export class RelayHostConnector {
    readonly #options: RelayHostConnectorOptions;
    readonly #publicKey: Uint8Array;
    readonly #timing: RelayConnectorTiming;
    readonly #now: () => number;
    readonly #random: () => number;
    readonly #scheme: 'ws' | 'wss';
    #attempt = 0;
    #control?: WebSocket;
    #isStarted = false;
    #lastPongAt = 0;
    #pingTimer?: ReturnType<typeof setInterval>;
    #reconnectTimer?: ReturnType<typeof setTimeout>;
    #registeredAt?: number;
    #sentGrants = new Map<string, number | undefined>();
    #stableTimer?: ReturnType<typeof setTimeout>;
    #state: RelayConnectorState = 'stopped';
    readonly hostId: string;

    constructor(options: RelayHostConnectorOptions) {
        this.#options = options;
        this.#publicKey = relayHostPublicKey(options.secretKey);
        this.hostId = relayHostIdForPublicKey(this.#publicKey);
        this.#timing = { ...defaultRelayConnectorTiming, ...options.timing };
        this.#now = options.now ?? Date.now;
        this.#random = options.random ?? Math.random;
        this.#scheme = new URL(options.url).protocol === 'wss:' ? 'wss' : 'ws';
    }

    get state(): RelayConnectorState {
        return this.#state;
    }

    start(): void {
        if (this.#isStarted) return;
        this.#isStarted = true;
        this.#connect('started');
    }

    stop(): void {
        if (!this.#isStarted) return;
        this.#isStarted = false;
        clearTimeout(this.#reconnectTimer);
        this.#teardownControl();
        this.#transition('stopped', 'disabled');
    }

    /**
     * Sends the difference between the current grants and the last set the Relay acknowledged by registration.
     */
    syncGrants(): void {
        if (this.#state !== 'online' || !this.#control) return;
        const next = this.#currentGrants();
        const add: RelayGrant[] = [];
        const remove: string[] = [];
        for (const [keyHash, expiresAt] of next)
            if (!this.#sentGrants.has(keyHash) || this.#sentGrants.get(keyHash) !== expiresAt)
                add.push({ keyHash, ...(expiresAt !== undefined && { expiresAt }) });
        const now = this.#now();
        // The Relay prunes expired grants itself without cutting their splices; an explicit remove would cut them.
        for (const [keyHash, expiresAt] of this.#sentGrants)
            if (!next.has(keyHash) && (expiresAt === undefined || expiresAt > now))
                remove.push(keyHash);
        if (add.length === 0 && remove.length === 0) return;
        this.#sentGrants = next;
        this.#send(this.#control, { type: 'grant-update', add, remove });
    }

    #currentGrants(): Map<string, number | undefined> {
        const now = this.#now();
        const grants = new Map<string, number | undefined>();
        for (const grant of this.#options.grants()) {
            if (grants.size >= RELAY_MAX_GRANTS) break;
            if (grant.expiresAt !== undefined && grant.expiresAt <= now) continue;
            grants.set(grant.keyHash, grant.expiresAt);
        }
        return grants;
    }

    #createSocket(url: string): WebSocket {
        return this.#options.createWebSocket?.(url) ?? new WebSocket(url, wireOptions);
    }

    #connect(cause: RelayStateCause): void {
        if (!this.#isStarted) return;
        this.#transition('connecting', cause);
        const control = this.#createSocket(relayEndpoint(this.#options.url, relayPaths.host));
        this.#control = control;
        let challenge: Uint8Array | undefined;
        let closeCause: RelayStateCause | undefined;
        const fail = (reason: RelayStateCause): void => {
            closeCause ??= reason;
            control.terminate();
        };
        control.on('error', () => {
            closeCause ??= 'network-error';
        });
        control.on('pong', () => {
            this.#lastPongAt = this.#now();
        });
        control.on('message', (data, isBinary) => {
            if (this.#control !== control) return;
            try {
                if (isBinary) throw new Error('Relay control frames are text');
                const raw = JSON.parse(messageText(data)) as unknown;
                if (!challenge) {
                    const parsed = relayChallengeSchema.parse(raw);
                    challenge = decodeHex(parsed.nonce, RELAY_CHALLENGE_BYTES);
                    const grants = this.#currentGrants();
                    const signature = signRelayHostChallenge(this.#options.secretKey, challenge);
                    this.#send(
                        control,
                        relayHostRegisterSchema.parse({
                            type: 'host-register',
                            version: RELAY_PROTOCOL_VERSION,
                            publicKey: encodeHex(this.#publicKey),
                            signature: encodeHex(signature),
                            grants: grantList(grants),
                        }),
                    );
                    this.#sentGrants = grants;
                    return;
                }
                if (this.#state !== 'online') {
                    const registered = relayHostRegisteredSchema.parse(raw);
                    if (registered.hostId !== this.hostId)
                        throw new Error('Relay confirmed another host identity');
                    this.#onRegistered(control);
                    return;
                }
                this.#dialBack(relayIncomingSchema.parse(raw));
            } catch {
                fail('protocol-error');
            }
        });
        control.on('close', (code) => {
            if (this.#control !== control) return;
            const relayReason = relayCloseReasonOf(code);
            const cause =
                closeCause ??
                (relayReason === 'unauthorized'
                    ? 'registration-rejected'
                    : relayReason
                      ? 'closed-by-relay'
                      : 'network-error');
            this.#teardownControl();
            this.#scheduleReconnect(cause, relayReason);
        });
        this.#heartbeat(control, () => fail('heartbeat-timeout'));
    }

    #onRegistered(control: WebSocket): void {
        this.#registeredAt = this.#now();
        this.#transition('online', 'registered');
        clearTimeout(this.#stableTimer);
        this.#stableTimer = setTimeout(() => {
            if (this.#control === control) this.#attempt = 0;
        }, this.#timing.stableAfterMs);
        this.#stableTimer.unref();
        // Grants may have changed between the registration frame and its acknowledgement.
        this.syncGrants();
    }

    #heartbeat(control: WebSocket, onTimeout: () => void): void {
        clearInterval(this.#pingTimer);
        this.#lastPongAt = this.#now();
        this.#pingTimer = setInterval(() => {
            if (this.#control !== control) return;
            if (this.#now() - this.#lastPongAt > this.#timing.pongTimeoutMs) {
                onTimeout();
                return;
            }
            if (control.readyState === WebSocket.OPEN) control.ping();
        }, this.#timing.pingIntervalMs);
        this.#pingTimer.unref();
    }

    #dialBack(incoming: { connectionId: string; ticket: string }): void {
        if (!this.#options.canAccept()) {
            this.#dialFailed('capacity');
            return;
        }
        const socket = this.#createSocket(relayEndpoint(this.#options.url, relayPaths.hostData));
        let isHandedOff = false;
        const timeout = setTimeout(() => {
            if (isHandedOff) return;
            this.#dialFailed('dial-failed');
            socket.terminate();
        }, this.#timing.dialTimeoutMs);
        timeout.unref();
        socket.once('error', () => {
            if (isHandedOff) return;
            clearTimeout(timeout);
            this.#dialFailed('dial-failed');
        });
        socket.once('close', (code) => {
            if (isHandedOff) return;
            clearTimeout(timeout);
            this.#dialFailed(relayCloseReasonOf(code) ? 'accept-rejected' : 'dial-failed');
        });
        socket.once('open', () => {
            clearTimeout(timeout);
            if (!this.#isStarted || !this.#options.canAccept()) {
                isHandedOff = true;
                socket.close();
                this.#dialFailed('capacity');
                return;
            }
            socket.send(
                JSON.stringify(
                    relayHostAcceptSchema.parse({
                        type: 'host-accept',
                        version: RELAY_PROTOCOL_VERSION,
                        hostId: this.hostId,
                        connectionId: incoming.connectionId,
                        ticket: incoming.ticket,
                    }),
                ),
            );
            isHandedOff = true;
            socket.removeAllListeners('error');
            socket.removeAllListeners('close');
            this.#options.onConnection(socket);
        });
    }

    #dialFailed(reason: RelayDialFailure): void {
        this.#options.logger?.write('warn', logEventCatalog.mobileGateway.relayDialFailed, {
            fields: { reason },
        });
    }

    #send(socket: WebSocket, payload: unknown): void {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    }

    #teardownControl(): void {
        clearInterval(this.#pingTimer);
        clearTimeout(this.#stableTimer);
        const control = this.#control;
        this.#control = undefined;
        this.#sentGrants = new Map();
        if (control && control.readyState !== WebSocket.CLOSED) control.terminate();
    }

    #scheduleReconnect(cause: RelayStateCause, relayReason?: RelayCloseReason): void {
        if (!this.#isStarted) return;
        this.#attempt += 1;
        const ceiling = Math.min(
            this.#timing.maxBackoffMs,
            this.#timing.initialBackoffMs * 2 ** Math.min(this.#attempt - 1, 16),
        );
        const delay = Math.round(ceiling * (0.5 + this.#random() * 0.5));
        this.#transition('offline', cause, relayReason);
        this.#reconnectTimer = setTimeout(() => this.#connect(cause), delay);
        this.#reconnectTimer.unref();
    }

    #transition(
        state: RelayConnectorState,
        cause: RelayStateCause,
        relayReason?: RelayCloseReason,
    ): void {
        const isLeavingOnline = this.#state === 'online' && state !== 'online';
        const connectedMs =
            isLeavingOnline && this.#registeredAt !== undefined
                ? this.#now() - this.#registeredAt
                : undefined;
        if (isLeavingOnline) this.#registeredAt = undefined;
        this.#state = state;
        this.#options.logger?.write(
            state === 'offline' && cause !== 'closed-by-relay' ? 'warn' : 'info',
            logEventCatalog.mobileGateway.relayState,
            {
                fields: {
                    state,
                    cause,
                    attempt: this.#attempt,
                    scheme: this.#scheme,
                    ...(relayReason !== undefined && { relayReason }),
                    ...(connectedMs !== undefined && { connectedMs }),
                },
            },
        );
    }
}
/* eslint-enable unicorn/consistent-class-member-order */
