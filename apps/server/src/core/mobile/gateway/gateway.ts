import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import {
    encodeHex,
    handshakeConfirmation,
    MOBILE_GATEWAY_MAX_WIRE_BYTES,
    MOBILE_TRANSPORT_VERSION,
    mobileClientHelloSchema,
    mobileRevokedSchema,
    mobileServerHelloSchema,
    serializeMobilePairingLink,
} from '@caxri/mobile-transport';
import type {
    CommandDispatcher,
    CommandExecutionContext,
    MobileAccessStatus,
    ServerEvent,
} from '@caxri/protocol';
import { CaxriError, createCommandDispatcher } from '@caxri/protocol';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

import type { MobileDeviceSummary } from '../device-registry';
import { MobileRelayRoute } from '../relay';
import type { MobileUpdateSource } from '../update-bundle';
import { selectMobileGatewayAddresses } from './address-selection';
import {
    admitMobileTcpConnection,
    hasMobileSocketCapacity,
    isAllowedMobilePeer,
    MAXIMUM_MOBILE_CONNECTIONS,
    mobileUpgradeFailure,
} from './admission';
import { hasMobileAttentionRecipient } from './attention-recipient';
import type { AuthenticateConnectionDependencies } from './authenticate-connection';
import { authenticateConnection, connectionOptions } from './authenticate-connection';
import { bindMobileGatewayServer } from './bind';
import type {
    MobileConnectionEnd,
    MobileConnectionRoute,
    MobileGatewayFailureReason,
} from './diagnostics';
import { mobileConnectionEnd, MobileGatewayDiagnostics } from './diagnostics';
import type { MobileGatewayOptions } from './gateway-options';
import type { GatewaySession } from './gateway-session';
import { beginMobileHandshake, versionMismatchFrame } from './handshake';
import { handshakeTimingFields } from './handshake-timing';
import { MobilePairingLedger } from './pairing-ledger';
import { adoptCurrentPairedPrincipal, currentPrincipalAdapter } from './principal-grant';
import { mobileCapabilitiesByRole } from './role-capabilities';
import {
    MobileFrameReplayRejected,
    openSessionPayload,
    sealSessionPayload,
    sendFinalSealedPayload,
} from './sealed-payload';
import { messageByteLength, messageText } from './socket-message';
import { MobileSocketQueueBudget } from './socket-queue-budget';
import { SourceAttemptLimiter } from './source-attempt-limiter';
import { MobileUpdateDownloads } from './update-downloads';
import {
    isMobileUpdateRecoveryHello,
    MobileUpdateRecoveryExchange,
    sendUpdateRecoveryAnswer,
} from './update-recovery';

export { selectMobileGatewayAddress } from './address-selection';
export { boundedMobileReply } from './reply';

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Default-off LAN transport for one Server profile. The loopback control transport is never reused.
 */
/* eslint-disable unicorn/consistent-class-member-order -- The public lifecycle API stays together before handshake internals. */
export class MobileGateway {
    readonly #activeByDevice = new Map<string, Map<WebSocket, GatewaySession>>();
    readonly #authenticationDependencies: AuthenticateConnectionDependencies;
    readonly #dispatch: CommandDispatcher;
    readonly #diagnostics: MobileGatewayDiagnostics;
    readonly #handshakeTimeoutMs: number;
    readonly #now: () => number;
    readonly #options: MobileGatewayOptions;
    readonly #pairings: MobilePairingLedger;
    readonly #random: (bytes: number) => Uint8Array;
    /**
     * Revocations still being written; the registry's memory changes only after its atomic file replacement.
     */
    readonly #revokingDevices = new Set<string>();
    readonly #sockets = new Set<WebSocket>();
    readonly #sourceAttempts: SourceAttemptLimiter;
    readonly #tcpSockets = new Set<Socket>();
    readonly #terminators = new Map<WebSocket, (reason?: MobileGatewayFailureReason) => void>();
    /**
     * Sockets `disable()` cut off, so their close records read as a disabled gateway instead of a dropped peer.
     */
    readonly #disabledSockets = new WeakSet<WebSocket>();
    readonly #updateDownloads: MobileUpdateDownloads;
    readonly #stopObserverEvents?: () => void;
    readonly #stopHostExit?: () => void;
    readonly #relay: MobileRelayRoute;
    #addresses?: string[];
    #handshakes = 0;
    #port?: number;
    #server?: Server;
    #webSocketServer?: WebSocketServer;

    constructor(options: MobileGatewayOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
        this.#diagnostics = new MobileGatewayDiagnostics(options.logger, this.#now);
        this.#sourceAttempts = new SourceAttemptLimiter({ now: this.#now });
        this.#random = options.random ?? randomBytes;
        this.#pairings = new MobilePairingLedger(this.#now, this.#random);
        this.#updateDownloads = new MobileUpdateDownloads({
            ...options,
            now: this.#now,
            random: this.#random,
        });
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
        this.#dispatch = createCommandDispatcher({
            server: currentPrincipalAdapter(options.adapters.server, options.registry),
            maximumReceipts: 256,
        });
        this.#relay = new MobileRelayRoute({
            registry: options.registry,
            pendingPairingSecrets: () => this.#pairings.pending(),
            canAccept: () => hasMobileSocketCapacity(this.#sockets.size, this.#handshakes),
            onConnection: (socket, dialMs) => this.#accept(socket, undefined, 'relay', dialMs),
            ...(options.logger && { logger: options.logger }),
            now: this.#now,
            ...(options.relayTiming && { timing: options.relayTiming }),
        });
        this.#authenticationDependencies = {
            context: (session) => this.#context(session),
            dispatch: this.#dispatch,
            diagnostics: this.#diagnostics,
            now: this.#now,
            options: connectionOptions(options),
            random: this.#random,
            sendSealed: (socket, session, payload, onSent) =>
                this.#sendSealed(socket, session, payload, onSent),
        };
    }

    status(): MobileAccessStatus {
        this.#pairings.removeExpired();
        const relay = this.#relay.status();
        return {
            enabled: Boolean(this.#server?.listening),
            ...(this.#addresses?.[0] && { address: this.#addresses[0] }),
            ...(this.#port && { port: this.#port }),
            pairedDeviceCount: this.#options.registry.list().filter((device) => !device.revokedAt)
                .length,
            pendingPairingCount: this.#pairings.size,
            ...(relay && { relay }),
        };
    }

    /**
     * Applies `mobile.relayUrl`; resolves once the host key is loaded so the next pairing link carries the Relay.
     */
    configureRelay(url: string | null | undefined): Promise<void> {
        return this.#relay.configure(url);
    }

    /**
     * Total authenticated ("ready") Mobile connections across every paired device. Handshakes still in progress do not
     * count, matching `onConnectionCountChanged`, which only fires once a session actually reaches this set.
     */
    connectionCount(): number {
        let total = 0;
        for (const sockets of this.#activeByDevice.values()) total += sockets.size;
        return total;
    }

    #notifyConnectionCount(): void {
        this.#options.onConnectionCountChanged?.(this.connectionCount());
    }

    hasAttentionRecipient(projectId: string): boolean {
        return hasMobileAttentionRecipient(
            this.#activeByDevice.values(),
            this.#options.registry,
            projectId,
        );
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
        const session = this.#authenticatedSession(context);
        if (!session.application)
            throw new CaxriError('NOT_FOUND', 'Terminal subscription not found');
        return session.application.terminalSubscription(subscriptionId, terminalId);
    }

    /**
     * The local address the requesting phone reached this gateway on, which plain-HTTP side channels (update downloads,
     * previews) must reuse so the phone can reach them on the same network path.
     */
    connectionAddress(context: CommandExecutionContext): string {
        const { localAddress, route } = this.#authenticatedSession(context);
        if (route === 'relay')
            throw new CaxriError('UNAVAILABLE', 'Not available over the Relay route');
        if (!localAddress || !this.#port)
            throw new CaxriError('UNAVAILABLE', 'Mobile access is disabled');
        return localAddress;
    }

    prepareUpdateDownload(context: CommandExecutionContext, source: MobileUpdateSource) {
        const { deviceId, generation, route } = this.#authenticatedSession(context);
        if (route === 'relay') return this.#updateDownloads.releaseAsset(source);
        const origin = `http://${this.connectionAddress(context)}:${this.#port}`;
        return this.#updateDownloads.issue({ deviceId, generation }, source, origin);
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
            if (!isAllowedMobilePeer(sourceAddress(request.socket), request.socket.localAddress)) {
                request.socket.destroy();
                return;
            }
            if (this.#updateDownloads.handle(request, response)) return;
            response.writeHead(404, { Connection: 'close' }).end();
        });
        server.headersTimeout = this.#handshakeTimeoutMs;
        server.requestTimeout = this.#handshakeTimeoutMs;
        server.keepAliveTimeout = 1_000;
        server.maxConnections = MAXIMUM_MOBILE_CONNECTIONS;
        server.on('drop', () => this.#diagnostics.failure('admissionCapacity'));
        server.on('connection', (socket) => {
            const remoteAddress = sourceAddress(socket);
            admitMobileTcpConnection(socket, {
                canAdmitSource: () => this.#sourceAttempts.admit(remoteAddress ?? 'unknown'),
                onRejected: (reason) => this.#diagnostics.failure(reason),
                remoteAddress,
                sockets: this.#tcpSockets,
                timeoutMs: this.#handshakeTimeoutMs,
            });
        });
        server.on('upgrade', (request, socket, head) => {
            const rejection = mobileUpgradeFailure(
                request,
                sourceAddress(request.socket),
                this.#sockets.size,
                this.#handshakes,
            );
            if (rejection) {
                this.#diagnostics.failure(rejection);
                socket.destroy();
                return;
            }
            (socket as Socket).setTimeout(0);
            webSocketServer.handleUpgrade(request, socket, head, (connection) => {
                webSocketServer.emit('connection', connection, request);
            });
        });
        webSocketServer.on('connection', (socket, request: IncomingMessage) =>
            this.#accept(socket, request.socket.localAddress),
        );
        const port = await bindMobileGatewayServer({
            registry: this.#options.registry,
            server,
            webSocketServer,
        });
        this.#addresses = addresses;
        this.#port = port;
        this.#server = server;
        this.#webSocketServer = webSocketServer;
        this.#diagnostics.gatewayEnabled();
        await this.#relay.activate();
        return this.status();
    }

    createPairing(projectIds: string[]): { expiresAt: number; pairingLink: string } {
        if (!this.#server?.listening || !this.#addresses || !this.#port)
            throw new CaxriError('UNAVAILABLE', 'Mobile access is disabled');
        const pairing = this.#pairings.create(projectIds);
        this.#diagnostics.pairingOutcome('started');
        this.#relay.syncGrants();
        const relay = this.#relay.pairingTarget();
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
                ...(relay && { relay }),
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
        this.#revokingDevices.add(deviceId);
        this.#updateDownloads.revokeDevice(deviceId);
        const resumeGrantUpdates = this.#relay.deferGrantUpdates();
        let revoked: MobileDeviceSummary;
        try {
            try {
                revoked = await this.#options.registry.revoke(deviceId, expectedGeneration);
            } catch (error) {
                if (activeSessions)
                    for (const session of activeSessions.values()) session.revoking = false;
                throw error;
            } finally {
                this.#revokingDevices.delete(deviceId);
            }
            if (activeSessions)
                for (const session of activeSessions.values()) session.application?.close();
            if (activeSessions)
                await Promise.all(
                    [...activeSessions].map(([socket, session]) =>
                        this.#sendRevokedAndClose(socket, session),
                    ),
                );
        } finally {
            resumeGrantUpdates();
        }
        this.#activeByDevice.delete(deviceId);
        this.#updateDownloads.revokeDevice(deviceId);
        this.#notifyConnectionCount();
        return revoked;
    }

    async disable(): Promise<MobileAccessStatus> {
        const wasEnabled = Boolean(this.#server?.listening);
        this.#relay.deactivate();
        this.#pairings.clear();
        this.#sourceAttempts.clear();
        this.#updateDownloads.clear();
        for (const sockets of this.#activeByDevice.values())
            for (const session of sockets.values()) session.application?.close();
        for (const socket of this.#sockets) {
            this.#disabledSockets.add(socket);
            socket.terminate();
        }
        for (const socket of this.#tcpSockets) socket.destroy();
        this.#sockets.clear();
        this.#tcpSockets.clear();
        this.#activeByDevice.clear();
        this.#notifyConnectionCount();
        const server = this.#server;
        this.#server = undefined;
        this.#addresses = undefined;
        this.#port = undefined;
        if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        this.#webSocketServer?.close();
        this.#webSocketServer = undefined;
        if (wasEnabled) this.#diagnostics.gatewayDisabled();
        this.#diagnostics.flush();
        return this.status();
    }

    close(): Promise<MobileAccessStatus> {
        this.#stopObserverEvents?.();
        this.#stopHostExit?.();
        return this.disable();
    }

    /**
     * The single pipeline for every phone socket. A `'relay'` socket is the Server's own outbound dial-back, so it
     * skips only the private-network TCP and upgrade admission; everything after is the same as on the LAN listener.
     */
    #accept(
        socket: WebSocket,
        localAddress: string | undefined,
        route: MobileConnectionRoute = 'lan',
        dialMs?: number,
    ): void {
        const acceptedAt = this.#now();
        this.#sockets.add(socket);
        this.#handshakes += 1;
        let session: GatewaySession | undefined;
        let recovery: MobileUpdateRecoveryExchange | undefined;
        let isReady = false;
        let isAcceptingMessages = true;
        let didTerminate = false;
        let queue = Promise.resolve();
        const queueBudget = new MobileSocketQueueBudget();
        let serverEnd: MobileConnectionEnd | undefined;
        const terminate = (reason: MobileGatewayFailureReason = 'applicationClosed'): void => {
            if (didTerminate || session?.revoking) return;
            didTerminate = true;
            serverEnd =
                reason === 'heartbeatIdle'
                    ? { cause: 'heartbeat-idle' }
                    : { cause: 'server-terminated', failureReason: reason };
            this.#diagnostics.failure(reason);
            isAcceptingMessages = false;
            session?.application?.close();
            socket.terminate();
        };
        this.#terminators.set(socket, terminate);
        const timer = setTimeout(() => terminate('handshakeTimeout'), this.#handshakeTimeoutMs);
        timer.unref();
        const remove = (closeCode: number): void => {
            isAcceptingMessages = false;
            clearTimeout(timer);
            this.#terminators.delete(socket);
            this.#sockets.delete(socket);
            if (!isReady) this.#handshakes = Math.max(0, this.#handshakes - 1);
            if (!session) return;
            session.application?.close();
            if (session.readyAt !== undefined)
                this.#diagnostics.connectionEnded(
                    session.deviceId,
                    this.#now() - session.readyAt,
                    mobileConnectionEnd({
                        closeCode,
                        isDisabled: this.#disabledSockets.has(socket),
                        isRevoking: Boolean(session.revoking),
                        serverEnd,
                    }),
                    session.route,
                );
            const active = this.#activeByDevice.get(session.deviceId);
            const removed = active?.delete(socket) ?? false;
            if (active?.size === 0) this.#activeByDevice.delete(session.deviceId);
            if (removed) this.#notifyConnectionCount();
        };
        socket.on('close', remove);
        socket.on('error', () => terminate('transportError'));
        socket.on('message', (data, isBinary) => {
            if (!isAcceptingMessages) return;
            if (isBinary) {
                terminate('binaryFrame');
                return;
            }
            const releaseQueueCapacity = queueBudget.tryAcquire(messageByteLength(data));
            if (!releaseQueueCapacity) {
                terminate('inboundCapacity');
                return;
            }
            const previousMessage = queue;
            const currentMessage = (async (): Promise<void> => {
                await previousMessage;
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- disable/revoke can terminate this socket while the previous frame is awaiting I/O.
                if (!isAcceptingMessages) return;
                const raw = JSON.parse(messageText(data)) as unknown;
                if (!session) {
                    if (recovery) {
                        isAcceptingMessages = false;
                        await sendUpdateRecoveryAnswer(socket, recovery, raw, {
                            diagnostics: this.#diagnostics,
                            terminate,
                        });
                        return;
                    }
                    if (isMobileUpdateRecoveryHello(raw)) {
                        recovery = this.#beginUpdateRecovery(raw, localAddress);
                        socket.send(recovery.challenge);
                        return;
                    }
                    const mismatch = versionMismatchFrame(raw);
                    if (mismatch) {
                        this.#diagnostics.failure('versionMismatch');
                        isAcceptingMessages = false;
                        socket.send(mismatch, (error) => {
                            if (error) terminate('sendFailed');
                            else socket.close(1_000, 'Version mismatch');
                        });
                        return;
                    }
                    const hello = mobileClientHelloSchema.parse(raw);
                    session = {
                        ...beginMobileHandshake(hello, {
                            bootId: this.#options.bootId,
                            diagnostics: this.#diagnostics,
                            now: this.#now,
                            pairings: this.#pairings,
                            protocolIdentity: this.#options.protocolIdentity,
                            random: this.#random,
                            registry: this.#options.registry,
                        }),
                        localAddress,
                        route,
                        timing: {
                            acceptedAt,
                            dialMs,
                            helloAt: this.#now(),
                            trace: hello.mode === 'connect' ? hello.trace : undefined,
                        },
                    };
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
                    session.timing.challengeAt = this.#now();
                    return;
                }
                if (!isReady) {
                    session.timing.confirmAt ??= this.#now();
                    const app = await authenticateConnection(
                        this.#authenticationDependencies,
                        session,
                        socket,
                        raw,
                        () => isAcceptingMessages,
                        terminate,
                    );
                    if (!app) return;
                    session.application = app;
                    isReady = true;
                    session.readyAt = this.#now();
                    this.#diagnostics.connectionEstablished(
                        session.deviceId,
                        session.route,
                        handshakeTimingFields(session.timing, session.readyAt),
                    );
                    this.#handshakes = Math.max(0, this.#handshakes - 1);
                    clearTimeout(timer);
                    const active =
                        this.#activeByDevice.get(session.deviceId) ??
                        new Map<WebSocket, GatewaySession>();
                    active.set(socket, session);
                    this.#activeByDevice.set(session.deviceId, active);
                    this.#notifyConnectionCount();
                    return;
                }
                session.application?.accept(openSessionPayload(session, raw));
            })();
            queue = (async (): Promise<void> => {
                try {
                    await currentMessage;
                } catch (error) {
                    if (error instanceof MobileFrameReplayRejected) terminate('replayRejected');
                    else terminate(isReady ? 'invalidFrame' : 'invalidHandshake');
                } finally {
                    releaseQueueCapacity();
                }
            })();
        });
    }

    #beginUpdateRecovery(
        raw: unknown,
        localAddress: string | undefined,
    ): MobileUpdateRecoveryExchange {
        try {
            return MobileUpdateRecoveryExchange.begin(raw, {
                downloads: this.#updateDownloads,
                isRevoking: (deviceId) => this.#revokingDevices.has(deviceId),
                origin: () =>
                    localAddress && this.#port ? `http://${localAddress}:${this.#port}` : undefined,
                random: this.#random,
                registry: this.#options.registry,
                serverId: this.#options.protocolIdentity.serverId,
                updateSource: this.#options.updateSource,
            });
        } catch (error) {
            this.#diagnostics.updateRecovery('invalid-frame');
            throw error;
        }
    }

    #authenticatedSession(context: CommandExecutionContext): GatewaySession {
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
        return session;
    }

    #context(session: GatewaySession): CommandExecutionContext {
        const current = this.#options.registry.currentPrincipal(
            session.deviceId,
            session.generation,
        );
        const principal = adoptCurrentPairedPrincipal(session.principal, current);
        if (!principal) throw new CaxriError('FORBIDDEN', 'Paired device authorization changed');
        session.principal = principal;
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
        const sourceFrame = sealSessionPayload(session, payload);
        if (
            socket.readyState !== 1 ||
            socket.bufferedAmount + Buffer.byteLength(sourceFrame, 'utf8') >
                MOBILE_GATEWAY_MAX_WIRE_BYTES * 2
        ) {
            this.#terminate(socket, 'outboundCapacity');
            onSent?.(new Error('Mobile socket cannot accept another frame'));
            return;
        }
        socket.send(sourceFrame, (error) => {
            if (error) this.#terminate(socket, 'sendFailed');
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
        const sourceFrame = sealSessionPayload(session, revoked);
        const maxBytes = MOBILE_GATEWAY_MAX_WIRE_BYTES * 2;
        const closeResult = await sendFinalSealedPayload(socket, sourceFrame, maxBytes);
        if (closeResult === 'failed') {
            session.application?.close();
            socket.terminate();
        }
    }

    #terminate(socket: WebSocket, reason: MobileGatewayFailureReason): void {
        const terminate = this.#terminators.get(socket);
        if (terminate) terminate(reason);
        else socket.terminate();
    }
}
/* eslint-enable unicorn/consistent-class-member-order */
