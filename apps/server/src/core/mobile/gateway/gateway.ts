import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import type {
    HandshakeTranscript,
    MobileClientHello,
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
    isPrivateMobileIpv4Address,
    MOBILE_GATEWAY_MAX_WIRE_BYTES,
    MOBILE_TRANSPORT_VERSION,
    mobileClientConfirmationSchema,
    mobileClientHelloSchema,
    MobileFrameCounter,
    mobilePairingResultSchema,
    mobilePublicKey,
    MobileReplayGuard,
    mobileRevokedSchema,
    mobileSealedFrameSchema,
    mobileServerHelloSchema,
    mobileVersionMismatchSchema,
    openMobileFrame,
    PAIRING_SECRET_BYTES,
    serializeMobilePairingLink,
    X25519_KEY_BYTES,
} from '@caxri/mobile-transport';
import type {
    CommandAdapter,
    CommandDispatcher,
    CommandDispatcherOptions,
    CommandExecutionContext,
    MobileAccessStatus,
    Principal,
    ProtocolConnectionIdentity,
    ServerEvent,
} from '@caxri/protocol';
import { CaxriError, createCommandDispatcher } from '@caxri/protocol';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import type {
    MobileDeviceRecord,
    MobileDeviceRegistry,
    MobileDeviceSummary,
} from '../device-registry';
import { selectMobileGatewayAddresses } from './address-selection';
import { MobileGatewayFrameRouter } from './frame-router';
import { dummyCandidate } from './handshake-candidate';
import { isAllowedMobileOrigin } from './origin';
import { mobileCapabilitiesByRole } from './role-capabilities';
import { createServerSealedPayload, sendFinalSealedPayload } from './sealed-payload';
import { messageByteLength, messageText } from './socket-message';
import { MobileSocketQueueBudget } from './socket-queue-budget';
import { SourceAttemptLimiter } from './source-attempt-limiter';

export { selectMobileGatewayAddress } from './address-selection';
export { boundedMobileReply } from './reply';

const MOBILE_PATH = '/mobile';
const HANDSHAKE_TIMEOUT_MS = 10_000;
const PAIRING_TTL_MS = 2 * 60_000;
const MAXIMUM_CONNECTIONS = 32;
const MAXIMUM_HANDSHAKES = 8;
const MAXIMUM_PENDING_PAIRINGS = 8;

interface PendingPairing {
    expiresAt: number;
    pairingId: string;
    projectIds: string[];
    secret: string;
}

interface GatewaySession {
    application?: MobileGatewayFrameRouter;
    candidate?: MobileDeviceRecord;
    connection: ProtocolConnectionIdentity;
    deviceId: string;
    generation: number;
    inbound: MobileReplayGuard;
    keys: MobileSessionKeys;
    mode: 'connect' | 'pair';
    outbound: MobileFrameCounter;
    principal?: Principal;
    revoking?: boolean;
    transcript: HandshakeTranscript;
    valid: boolean;
}

export interface MobileGatewayOptions {
    adapters: CommandDispatcherOptions;
    authorizePairedDeviceMethod: (principal: Principal, method: string) => void;
    authorizeSubscription: (
        principal: Principal,
        resource: MobileSubscriptionResource,
    ) => Promise<void>;
    bootId: string;
    now?: () => number;
    protocolIdentity: { serverId: string; stateEpoch: string };
    random?: (bytes: number) => Uint8Array;
    registry: MobileDeviceRegistry;
    matchesSubscriptionEvent: (
        principal: Principal,
        resource: MobileSubscriptionResource,
        event: ServerEvent,
    ) => Promise<boolean>;
    terminalExecution?: TerminalExecutionPort;
    /**
     * Peer address override for loopback tests.
     */
    sourceAddress?: (socket: Socket) => string | undefined;
    /**
     * Test seam; production always selects one private IPv4 interface.
     */
    selectAddress?: () => string;
}

const isAllowedLanAddress = (address: string | undefined): boolean =>
    address !== undefined && isPrivateMobileIpv4Address(address);

/**
 * Default-off LAN transport for one Server profile. The loopback control transport is never reused.
 */
/* eslint-disable unicorn/consistent-class-member-order -- The public lifecycle API stays together before handshake internals. */
export class MobileGateway {
    readonly #activeByDevice = new Map<string, Map<WebSocket, GatewaySession>>();
    readonly #dispatch: CommandDispatcher;
    readonly #now: () => number;
    readonly #options: MobileGatewayOptions;
    readonly #pairings = new Map<string, PendingPairing>();
    readonly #random: (bytes: number) => Uint8Array;
    readonly #sockets = new Set<WebSocket>();
    readonly #sourceAttempts: SourceAttemptLimiter;
    readonly #tcpSockets = new Set<Socket>();
    readonly #terminators = new Map<WebSocket, () => void>();
    readonly #stopObserverEvents?: () => void;
    readonly #stopHostExit?: () => void;
    #addresses?: string[];
    #handshakes = 0;
    #port?: number;
    #server?: Server;
    #webSocketServer?: WebSocketServer;

    constructor(options: MobileGatewayOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        this.#sourceAttempts = new SourceAttemptLimiter({ now: this.#now });
        this.#random = options.random ?? randomBytes;
        this.#stopObserverEvents = options.terminalExecution?.onObserverEvent((event) => {
            for (const sockets of this.#activeByDevice.values())
                for (const session of sockets.values())
                    session.application?.publishObserverEvent(event);
        });
        this.#stopHostExit = options.terminalExecution?.onHostExit((terminalIds) => {
            for (const sockets of this.#activeByDevice.values())
                for (const session of sockets.values())
                    for (const terminalId of terminalIds)
                        session.application?.invalidateTerminal(terminalId);
        });
        const adapter: CommandAdapter = {
            invoke: (request, context, invocation) => {
                if (context.principal.kind !== 'paired-device')
                    throw new CaxriError('FORBIDDEN', 'Paired device principal is required');
                const principal = options.registry.currentPrincipal(
                    context.principal.deviceId,
                    context.principal.generation,
                );
                return options.adapters.server.invoke(
                    request,
                    { ...context, principal },
                    invocation,
                );
            },
            isAvailable: () => options.adapters.server.isAvailable?.() !== false,
        };
        this.#dispatch = createCommandDispatcher({ server: adapter, maximumReceipts: 256 });
    }

    status(): MobileAccessStatus {
        this.#removeExpiredPairings();
        return {
            enabled: Boolean(this.#server?.listening),
            ...(this.#addresses?.[0] && { address: this.#addresses[0] }),
            ...(this.#port && { port: this.#port }),
            pairedDeviceCount: this.#options.registry.list().filter((device) => !device.revokedAt)
                .length,
            pendingPairingCount: this.#pairings.size,
        };
    }

    devices(): MobileDeviceSummary[] {
        return this.#options.registry.list();
    }

    publish(event: ServerEvent): void {
        for (const sockets of this.#activeByDevice.values())
            for (const session of sockets.values()) session.application?.publish(event);
    }

    terminalSubscription(
        context: CommandExecutionContext,
        subscriptionId: string,
        terminalId: string,
    ) {
        if (context.principal.kind !== 'paired-device')
            throw new CaxriError('FORBIDDEN', 'Paired device principal is required');
        const principal = context.principal;
        const connectionId = context.connection?.connectionId;
        if (!connectionId) throw new CaxriError('FORBIDDEN', 'Mobile connection is required');
        const sessions = this.#activeByDevice.get(principal.deviceId);
        const session = [...(sessions?.values() ?? [])].find(
            (item) =>
                item.connection.connectionId === connectionId &&
                item.generation === principal.generation &&
                !item.revoking,
        );
        if (!session) throw new CaxriError('NOT_FOUND', 'Mobile connection not found');
        this.#context(session);
        if (!session.application)
            throw new CaxriError('NOT_FOUND', 'Terminal subscription not found');
        return session.application.terminalSubscription(subscriptionId, terminalId);
    }

    async enable(): Promise<MobileAccessStatus> {
        if (this.#server?.listening) return this.status();
        const addresses = this.#options.selectAddress
            ? [this.#options.selectAddress()]
            : selectMobileGatewayAddresses();
        const sourceAddress =
            this.#options.sourceAddress ?? ((socket: Socket) => socket.remoteAddress);
        const webSocketServer = new WebSocketServer({
            maxPayload: MOBILE_GATEWAY_MAX_WIRE_BYTES,
            noServer: true,
            perMessageDeflate: false,
        });
        const server = createServer({ maxHeaderSize: 8 * 1_024 }, (request, response) => {
            if (
                !isAllowedLanAddress(sourceAddress(request.socket)) ||
                !isAllowedLanAddress(request.socket.localAddress)
            ) {
                request.socket.destroy();
                return;
            }
            response.writeHead(404, { Connection: 'close' }).end();
        });
        server.headersTimeout = HANDSHAKE_TIMEOUT_MS;
        server.requestTimeout = HANDSHAKE_TIMEOUT_MS;
        server.keepAliveTimeout = 1_000;
        server.maxConnections = MAXIMUM_CONNECTIONS;
        server.on('connection', (socket) => {
            const remoteAddress = sourceAddress(socket);
            if (
                !isAllowedLanAddress(remoteAddress) ||
                !isAllowedLanAddress(socket.localAddress) ||
                this.#tcpSockets.size >= MAXIMUM_CONNECTIONS ||
                !this.#admitSource(remoteAddress ?? 'unknown')
            ) {
                socket.destroy();
                return;
            }
            this.#tcpSockets.add(socket);
            socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => socket.destroy());
            socket.once('close', () => this.#tcpSockets.delete(socket));
        });
        server.on('upgrade', (request, socket, head) => {
            if (
                request.url !== MOBILE_PATH ||
                !isAllowedLanAddress(sourceAddress(request.socket)) ||
                !isAllowedLanAddress(request.socket.localAddress) ||
                !isAllowedMobileOrigin(request.headers.origin, request.headers.host) ||
                this.#sockets.size >= MAXIMUM_CONNECTIONS ||
                this.#handshakes >= MAXIMUM_HANDSHAKES
            ) {
                socket.destroy();
                return;
            }
            (socket as Socket).setTimeout(0);
            webSocketServer.handleUpgrade(request, socket, head, (connection) => {
                webSocketServer.emit('connection', connection, request);
            });
        });
        webSocketServer.on('connection', (socket) => this.#accept(socket));
        const preferredPort = this.#options.registry.preferredPort();
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error): void => reject(error);
                server.once('error', onError);
                server.listen(preferredPort ?? 0, '0.0.0.0', () => {
                    server.off('error', onError);
                    resolve();
                });
            });
        } catch {
            webSocketServer.close();
            throw new CaxriError(
                'UNAVAILABLE',
                preferredPort
                    ? 'The paired mobile endpoint is already in use'
                    : 'Mobile access could not open a local network endpoint',
            );
        }
        const bound = server.address();
        if (!bound || typeof bound === 'string') {
            webSocketServer.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            throw new CaxriError('UNAVAILABLE', 'Mobile gateway did not publish a TCP endpoint');
        }
        try {
            await this.#options.registry.rememberPort(bound.port);
        } catch (error) {
            webSocketServer.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            throw error;
        }
        this.#addresses = addresses;
        this.#port = bound.port;
        this.#server = server;
        this.#webSocketServer = webSocketServer;
        return this.status();
    }

    createPairing(projectIds: string[]): { expiresAt: number; pairingLink: string } {
        if (!this.#server?.listening || !this.#addresses || !this.#port)
            throw new CaxriError('UNAVAILABLE', 'Mobile access is disabled');
        this.#removeExpiredPairings();
        if (this.#pairings.size >= MAXIMUM_PENDING_PAIRINGS)
            throw new CaxriError('CAPACITY', 'Too many mobile pairings are pending');
        const pairing: PendingPairing = {
            pairingId: Buffer.from(this.#random(16)).toString('hex'),
            secret: Buffer.from(this.#random(PAIRING_SECRET_BYTES)).toString('hex'),
            projectIds: [...projectIds],
            expiresAt: this.#now() + PAIRING_TTL_MS,
        };
        this.#pairings.set(pairing.pairingId, pairing);
        return {
            expiresAt: pairing.expiresAt,
            pairingLink: serializeMobilePairingLink({
                version: MOBILE_TRANSPORT_VERSION,
                addresses: this.#addresses,
                port: this.#port,
                serverId: this.#options.protocolIdentity.serverId,
                pairingId: pairing.pairingId,
                secret: pairing.secret,
                expiresAt: pairing.expiresAt,
            }),
        };
    }

    async revoke(deviceId: string, expectedGeneration: number): Promise<MobileDeviceSummary> {
        const activeSessions = this.#activeByDevice.get(deviceId);
        if (activeSessions)
            for (const session of activeSessions.values()) {
                session.revoking = true;
                session.application?.abortPendingTerminalInputs();
            }
        let revoked: MobileDeviceSummary;
        try {
            revoked = await this.#options.registry.revoke(deviceId, expectedGeneration);
        } catch (error) {
            if (activeSessions)
                for (const session of activeSessions.values()) session.revoking = false;
            throw error;
        }
        if (activeSessions)
            for (const session of activeSessions.values()) session.application?.close();
        if (activeSessions)
            await Promise.all(
                [...activeSessions].map(([socket, session]) =>
                    this.#sendRevokedAndClose(socket, session),
                ),
            );
        this.#activeByDevice.delete(deviceId);
        return revoked;
    }

    async disable(): Promise<MobileAccessStatus> {
        this.#pairings.clear();
        this.#sourceAttempts.clear();
        for (const sockets of this.#activeByDevice.values())
            for (const session of sockets.values()) session.application?.close();
        for (const socket of this.#sockets) socket.terminate();
        for (const socket of this.#tcpSockets) socket.destroy();
        this.#sockets.clear();
        this.#tcpSockets.clear();
        this.#activeByDevice.clear();
        const server = this.#server;
        this.#server = undefined;
        this.#addresses = undefined;
        this.#port = undefined;
        if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        this.#webSocketServer?.close();
        this.#webSocketServer = undefined;
        return this.status();
    }

    close(): Promise<MobileAccessStatus> {
        this.#stopObserverEvents?.();
        this.#stopHostExit?.();
        return this.disable();
    }

    #admitSource(source: string): boolean {
        return this.#sourceAttempts.admit(source);
    }

    #removeExpiredPairings(): void {
        const now = this.#now();
        for (const [pairingId, pairing] of this.#pairings)
            if (pairing.expiresAt <= now) this.#pairings.delete(pairingId);
    }

    #accept(socket: WebSocket): void {
        this.#sockets.add(socket);
        this.#handshakes += 1;
        let session: GatewaySession | undefined;
        let isReady = false;
        let isAcceptingMessages = true;
        let queue = Promise.resolve();
        const queueBudget = new MobileSocketQueueBudget();
        const terminate = (): void => {
            if (session?.revoking) return;
            isAcceptingMessages = false;
            session?.application?.close();
            socket.terminate();
        };
        this.#terminators.set(socket, terminate);
        const timer = setTimeout(terminate, HANDSHAKE_TIMEOUT_MS);
        timer.unref();
        const remove = (): void => {
            isAcceptingMessages = false;
            clearTimeout(timer);
            this.#terminators.delete(socket);
            this.#sockets.delete(socket);
            if (!isReady) this.#handshakes = Math.max(0, this.#handshakes - 1);
            if (!session) return;
            session.application?.close();
            const active = this.#activeByDevice.get(session.deviceId);
            active?.delete(socket);
            if (active?.size === 0) this.#activeByDevice.delete(session.deviceId);
        };
        socket.on('close', remove);
        socket.on('error', () => {});
        socket.on('message', (data, isBinary) => {
            if (!isAcceptingMessages) return;
            if (isBinary) {
                terminate();
                return;
            }
            const releaseQueueCapacity = queueBudget.tryAcquire(messageByteLength(data));
            if (!releaseQueueCapacity) {
                terminate();
                return;
            }
            const previousMessage = queue;
            const currentMessage = (async (): Promise<void> => {
                await previousMessage;
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- disable/revoke can terminate this socket while the previous frame is awaiting I/O.
                if (!isAcceptingMessages) return;
                const raw = JSON.parse(messageText(data)) as unknown;
                if (!session) {
                    if (
                        typeof raw === 'object' &&
                        raw !== null &&
                        'type' in raw &&
                        raw.type === 'hello' &&
                        'version' in raw &&
                        typeof raw.version === 'number' &&
                        Number.isSafeInteger(raw.version) &&
                        raw.version !== MOBILE_TRANSPORT_VERSION
                    ) {
                        const mismatch = mobileVersionMismatchSchema.parse({
                            type: 'version-mismatch',
                            supportedVersion: MOBILE_TRANSPORT_VERSION,
                        });
                        isAcceptingMessages = false;
                        socket.send(JSON.stringify(mismatch), (error) => {
                            if (error) terminate();
                            else socket.close(1_000, 'Version mismatch');
                        });
                        return;
                    }
                    session = this.#beginHandshake(mobileClientHelloSchema.parse(raw));
                    const confirmation = handshakeConfirmation(session.keys, 'server');
                    const challenge = mobileServerHelloSchema.parse({
                        type: 'challenge',
                        version: MOBILE_TRANSPORT_VERSION,
                        connectionId: session.connection.connectionId,
                        deviceId: session.deviceId,
                        generation: session.generation,
                        serverPublicKey: encodeHex(session.transcript.serverPublicKey),
                        serverNonce: encodeHex(session.transcript.serverNonce),
                        confirmation: encodeHex(confirmation),
                    });
                    socket.send(JSON.stringify(challenge));
                    return;
                }
                if (!isReady) {
                    const confirmation = mobileClientConfirmationSchema.parse(raw);
                    if (
                        confirmation.connectionId !== session.connection.connectionId ||
                        !session.valid ||
                        !isHandshakeConfirmationValid(
                            decodeHex(confirmation.confirmation, 32),
                            session.keys,
                            'client',
                        )
                    ) {
                        terminate();
                        return;
                    }
                    let principal: Principal;
                    if (session.mode === 'pair') {
                        const candidate = session.candidate!;
                        await this.#options.registry.commitPair(candidate);
                        principal = this.#options.registry.currentPrincipal(
                            candidate.deviceId,
                            candidate.generation,
                        );
                        const pairingResult = mobilePairingResultSchema.parse({
                            type: 'paired',
                            deviceId: candidate.deviceId,
                            generation: candidate.generation,
                            credential: candidate.credential,
                            projectIds: candidate.projectIds,
                        });
                        this.#sendSealed(socket, session, pairingResult);
                    } else {
                        principal = this.#options.registry.currentPrincipal(
                            session.deviceId,
                            session.generation,
                        );
                        await this.#options.registry.markConnected(
                            session.deviceId,
                            session.generation,
                        );
                        this.#sendSealed(socket, session, {
                            type: 'ready',
                            deviceId: session.deviceId,
                            generation: session.generation,
                        });
                    }
                    session.principal = principal;
                    const authenticatedSession = session;
                    session.application = new MobileGatewayFrameRouter({
                        authorizeMethod: this.#options.authorizePairedDeviceMethod,
                        authorizeSubscription: this.#options.authorizeSubscription,
                        context: () => this.#context(authenticatedSession),
                        dispatch: this.#dispatch,
                        isActive: () =>
                            isAcceptingMessages &&
                            !authenticatedSession.revoking &&
                            socket.readyState === 1,
                        matchesSubscriptionEvent: this.#options.matchesSubscriptionEvent,
                        now: this.#now,
                        randomSubscriptionId: () => Buffer.from(this.#random(16)).toString('hex'),
                        send: (payload) =>
                            new Promise<void>((resolve, reject) => {
                                if (!isAcceptingMessages || authenticatedSession.revoking) {
                                    reject(new Error('Mobile session is no longer active'));
                                    return;
                                }
                                this.#context(authenticatedSession);
                                this.#sendSealed(socket, authenticatedSession, payload, (error) => {
                                    if (error) reject(error);
                                    else resolve();
                                });
                            }),
                        terminate,
                        terminalExecution: this.#options.terminalExecution,
                    });
                    isReady = true;
                    this.#handshakes = Math.max(0, this.#handshakes - 1);
                    clearTimeout(timer);
                    const active =
                        this.#activeByDevice.get(session.deviceId) ??
                        new Map<WebSocket, GatewaySession>();
                    active.set(socket, session);
                    this.#activeByDevice.set(session.deviceId, active);
                    return;
                }
                this.#handleSealed(session, raw);
            })();
            queue = (async (): Promise<void> => {
                try {
                    await currentMessage;
                } catch {
                    terminate();
                } finally {
                    releaseQueueCapacity();
                }
            })();
        });
    }

    #beginHandshake(hello: MobileClientHello): GatewaySession {
        const connectionId = Buffer.from(this.#random(16)).toString('hex');
        const serverSecretKey = this.#random(X25519_KEY_BYTES);
        const serverPublicKey = mobilePublicKey(serverSecretKey);
        const serverNonce = this.#random(HANDSHAKE_NONCE_BYTES);
        let deviceId: string;
        let generation: number;
        let presharedKey: Uint8Array;
        let principal: Principal | undefined;
        let candidate: MobileDeviceRecord | undefined;
        let isValid: boolean;
        if (hello.mode === 'pair') {
            this.#removeExpiredPairings();
            const pairing = this.#pairings.get(hello.pairingId);
            if (pairing) this.#pairings.delete(hello.pairingId);
            isValid = Boolean(pairing && pairing.expiresAt > this.#now());
            candidate = isValid
                ? this.#options.registry.preparePair({
                      displayName: hello.displayName,
                      platform: hello.platform,
                      projectIds: pairing!.projectIds,
                  })
                : dummyCandidate(hello, this.#now(), this.#random);
            deviceId = candidate.deviceId;
            generation = candidate.generation;
            presharedKey = decodeHex(
                pairing?.secret ?? Buffer.from(this.#random(PAIRING_SECRET_BYTES)).toString('hex'),
                PAIRING_SECRET_BYTES,
            );
        } else {
            const material = this.#options.registry.handshakeMaterial(
                hello.deviceId,
                hello.generation,
            );
            isValid = Boolean(material);
            deviceId = hello.deviceId;
            generation = hello.generation;
            principal = material?.principal;
            presharedKey = decodeHex(
                material?.credential ??
                    Buffer.from(this.#random(PAIRING_SECRET_BYTES)).toString('hex'),
                PAIRING_SECRET_BYTES,
            );
        }
        const transcript: HandshakeTranscript = {
            mode: hello.mode,
            serverId: this.#options.protocolIdentity.serverId,
            principalId: `paired-device:${deviceId}`,
            connectionId: decodeHex(connectionId, 16),
            clientPublicKey: decodeHex(hello.clientPublicKey, X25519_KEY_BYTES),
            serverPublicKey,
            clientNonce: decodeHex(hello.clientNonce, HANDSHAKE_NONCE_BYTES),
            serverNonce,
        };
        const keys = deriveMobileSessionKeys({
            localSecretKey: serverSecretKey,
            peerPublicKey: transcript.clientPublicKey,
            presharedKey,
            transcript,
        });
        return {
            candidate,
            connection: {
                serverId: this.#options.protocolIdentity.serverId,
                bootId: this.#options.bootId,
                stateEpoch: this.#options.protocolIdentity.stateEpoch,
                clientId: `mobile:${deviceId}`,
                connectionId,
            },
            deviceId,
            generation,
            inbound: new MobileReplayGuard(),
            keys,
            mode: hello.mode,
            outbound: new MobileFrameCounter(),
            principal,
            transcript,
            valid: isValid,
        };
    }

    #handleSealed(session: GatewaySession, raw: unknown): void {
        const frame = mobileSealedFrameSchema.parse(raw);
        if (frame.connectionId !== session.connection.connectionId)
            throw new Error('Encrypted frame connection identity changed');
        session.inbound.assertAndAdvance(frame.counter);
        const plaintext = openMobileFrame(
            session.keys.clientToServer,
            {
                connectionId: session.transcript.connectionId,
                counter: frame.counter,
                deviceId: session.deviceId,
                direction: 'client-to-server',
            },
            decodeHex(frame.ciphertext),
        );
        const source = new TextDecoder().decode(plaintext);
        session.application?.accept(JSON.parse(source) as unknown);
    }

    #context(session: GatewaySession): CommandExecutionContext {
        const current = this.#options.registry.currentPrincipal(
            session.deviceId,
            session.generation,
        );
        const principal = session.principal;
        if (
            principal?.kind !== 'paired-device' ||
            current.kind !== 'paired-device' ||
            current.id !== principal.id ||
            current.role !== principal.role ||
            current.projectIds.length !== principal.projectIds.length ||
            current.projectIds.some((id, index) => id !== principal.projectIds[index])
        )
            throw new CaxriError('FORBIDDEN', 'Paired device authorization changed');
        return {
            capabilities: mobileCapabilitiesByRole[principal.role],
            connection: session.connection,
            principal,
        };
    }

    #sendSealed(
        socket: WebSocket,
        session: GatewaySession,
        payload: unknown,
        onSent?: (error?: Error) => void,
    ): void {
        const counter = session.outbound.take();
        const sourceFrame = createServerSealedPayload(
            {
                connectionId: session.transcript.connectionId,
                connectionIdHex: session.connection.connectionId,
                counter,
                deviceId: session.deviceId,
                key: session.keys.serverToClient,
            },
            payload,
        );
        if (
            socket.readyState !== 1 ||
            socket.bufferedAmount + Buffer.byteLength(sourceFrame, 'utf8') >
                MOBILE_GATEWAY_MAX_WIRE_BYTES * 2
        ) {
            this.#terminate(socket);
            onSent?.(new Error('Mobile socket cannot accept another frame'));
            return;
        }
        socket.send(sourceFrame, (error) => {
            if (error) this.#terminate(socket);
            onSent?.(error);
        });
    }

    /**
     * A revocation is disclosed only over the already authenticated session. The bounded close handshake preserves wire
     * ordering for the encrypted control frame without letting a backpressured client delay Desktop indefinitely.
     */
    async #sendRevokedAndClose(socket: WebSocket, session: GatewaySession): Promise<void> {
        const revoked = mobileRevokedSchema.parse({
            type: 'revoked',
            deviceId: session.deviceId,
            generation: session.generation,
        });
        const counter = session.outbound.take();
        const sourceFrame = createServerSealedPayload(
            {
                connectionId: session.transcript.connectionId,
                connectionIdHex: session.connection.connectionId,
                counter,
                deviceId: session.deviceId,
                key: session.keys.serverToClient,
            },
            revoked,
        );
        const closeResult = await sendFinalSealedPayload(
            socket,
            sourceFrame,
            MOBILE_GATEWAY_MAX_WIRE_BYTES * 2,
        );
        if (closeResult === 'failed') {
            session.application?.close();
            socket.terminate();
        }
    }

    #terminate(socket: WebSocket): void {
        const terminate = this.#terminators.get(socket);
        if (terminate) terminate();
        else socket.terminate();
    }
}
/* eslint-enable unicorn/consistent-class-member-order */
