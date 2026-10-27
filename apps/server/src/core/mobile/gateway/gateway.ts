import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import {
    decodeHex,
    encodeHex,
    handshakeConfirmation,
    MOBILE_GATEWAY_MAX_WIRE_BYTES,
    MOBILE_TRANSPORT_VERSION,
    mobileClientCloseReasonOf,
    mobileClientHelloSchema,
    mobileRevokedSchema,
    mobileSealedFrameSchema,
    mobileServerHelloSchema,
    mobileVersionMismatchSchema,
    openMobileFrame,
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
import type { MobileUpdateSource } from '../update-bundle';
import { selectMobileGatewayAddresses } from './address-selection';
import {
    isAllowedMobilePeer,
    MAXIMUM_MOBILE_CONNECTIONS,
    mobileTcpAdmissionFailure,
    mobileUpgradeFailure,
} from './admission';
import { hasMobileAttentionRecipient } from './attention-recipient';
import type { AuthenticateConnectionDependencies } from './authenticate-connection';
import { authenticateConnection, connectionOptions } from './authenticate-connection';
import { bindMobileGatewayServer } from './bind';
import type { MobileConnectionEnd, MobileGatewayFailureReason } from './diagnostics';
import { MobileGatewayDiagnostics } from './diagnostics';
import type { MobileGatewayOptions } from './gateway-options';
import type { GatewaySession } from './gateway-session';
import { beginMobileHandshake } from './handshake';
import { MobilePairingLedger } from './pairing-ledger';
import { adoptCurrentPairedPrincipal, currentPrincipalAdapter } from './principal-grant';
import { mobileCapabilitiesByRole } from './role-capabilities';
import { createServerSealedPayload, sendFinalSealedPayload } from './sealed-payload';
import { messageByteLength, messageText } from './socket-message';
import { MobileSocketQueueBudget } from './socket-queue-budget';
import { SourceAttemptLimiter } from './source-attempt-limiter';
import { MobileUpdateDownloads } from './update-downloads';
import { isMobileUpdateRecoveryHello, MobileUpdateRecoveryExchange } from './update-recovery';

export { selectMobileGatewayAddress } from './address-selection';
export { boundedMobileReply } from './reply';

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Marker for `MobileReplayGuard`'s counter-sequence rejection so it logs as `replayRejected`, not `invalidFrame`.
 */
class MobileFrameReplayRejected extends Error {}

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
        return {
            enabled: Boolean(this.#server?.listening),
            ...(this.#addresses?.[0] && { address: this.#addresses[0] }),
            ...(this.#port && { port: this.#port }),
            pairedDeviceCount: this.#options.registry.list().filter((device) => !device.revokedAt)
                .length,
            pendingPairingCount: this.#pairings.size,
        };
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
     * Issues a download URL on the same address and port the requesting phone is connected through.
     */
    prepareUpdateDownload(
        context: CommandExecutionContext,
        source: MobileUpdateSource,
    ): { expiresAt: number; url: string } {
        const session = this.#authenticatedSession(context);
        if (!this.#port || !session.localAddress)
            throw new CaxriError('UNAVAILABLE', 'Mobile access is disabled');
        return this.#updateDownloads.issue(
            { deviceId: session.deviceId, generation: session.generation },
            source,
            `http://${session.localAddress}:${this.#port}`,
        );
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
            const rejection = mobileTcpAdmissionFailure(
                remoteAddress,
                socket.localAddress,
                this.#tcpSockets.size,
                () => this.#sourceAttempts.admit(remoteAddress ?? 'unknown'),
            );
            if (rejection) {
                this.#diagnostics.failure(rejection);
                socket.destroy();
                return;
            }
            this.#tcpSockets.add(socket);
            socket.setTimeout(this.#handshakeTimeoutMs, () => socket.destroy());
            socket.once('close', () => this.#tcpSockets.delete(socket));
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
        return this.status();
    }

    createPairing(projectIds: string[]): { expiresAt: number; pairingLink: string } {
        if (!this.#server?.listening || !this.#addresses || !this.#port)
            throw new CaxriError('UNAVAILABLE', 'Mobile access is disabled');
        const pairing = this.#pairings.create(projectIds);
        this.#diagnostics.pairingOutcome('started');
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
        this.#revokingDevices.add(deviceId);
        this.#updateDownloads.revokeDevice(deviceId);
        let revoked: MobileDeviceSummary;
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
        this.#activeByDevice.delete(deviceId);
        this.#updateDownloads.revokeDevice(deviceId);
        this.#notifyConnectionCount();
        return revoked;
    }

    async disable(): Promise<MobileAccessStatus> {
        const wasEnabled = Boolean(this.#server?.listening);
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

    #accept(socket: WebSocket, localAddress: string | undefined): void {
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
                    this.#connectionEnd(socket, session, serverEnd, closeCode),
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
                        await this.#completeUpdateRecovery(socket, recovery, raw, terminate);
                        return;
                    }
                    if (isMobileUpdateRecoveryHello(raw)) {
                        recovery = this.#beginUpdateRecovery(raw, localAddress);
                        socket.send(recovery.challenge);
                        return;
                    }
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
                        this.#diagnostics.failure('versionMismatch');
                        isAcceptingMessages = false;
                        socket.send(JSON.stringify(mismatch), (error) => {
                            if (error) terminate('sendFailed');
                            else socket.close(1_000, 'Version mismatch');
                        });
                        return;
                    }
                    session = beginMobileHandshake(mobileClientHelloSchema.parse(raw), {
                        bootId: this.#options.bootId,
                        diagnostics: this.#diagnostics,
                        now: this.#now,
                        pairings: this.#pairings,
                        protocolIdentity: this.#options.protocolIdentity,
                        random: this.#random,
                        registry: this.#options.registry,
                    });
                    session.localAddress = localAddress;
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
                    this.#diagnostics.connectionEstablished(session.deviceId);
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
                this.#handleSealed(session, raw);
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

    /**
     * Sends the single recovery answer and closes; the socket never becomes an application session.
     */
    async #completeUpdateRecovery(
        socket: WebSocket,
        recovery: MobileUpdateRecoveryExchange,
        raw: unknown,
        terminate: (reason?: MobileGatewayFailureReason) => void,
    ): Promise<void> {
        const { frame, outcome } = await recovery.complete(raw);
        this.#diagnostics.updateRecovery(outcome);
        if (!frame) {
            terminate('invalidHandshake');
            return;
        }
        if (socket.readyState !== 1) return;
        socket.send(frame, (error) => {
            if (error) terminate('sendFailed');
            else socket.close(1_000, 'Update recovery complete');
        });
    }

    #handleSealed(session: GatewaySession, raw: unknown): void {
        const frame = mobileSealedFrameSchema.parse(raw);
        if (frame.connectionId !== session.connection.connectionId)
            throw new Error('Encrypted frame connection identity changed');
        // Narrowed to a distinct error type so the outer catch can log `replayRejected` instead of folding a replayed
        // or out-of-order counter into the generic `invalidFrame` bucket it shares with malformed payloads.
        try {
            session.inbound.assertAndAdvance(frame.counter);
        } catch (error) {
            throw new MobileFrameReplayRejected(error instanceof Error ? error.message : undefined);
        }
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

    #sealedPayload(session: GatewaySession, payload: unknown): string {
        return createServerSealedPayload(
            {
                connectionId: session.transcript.connectionId,
                connectionIdHex: session.connection.connectionId,
                counter: session.outbound.take(),
                deviceId: session.deviceId,
                key: session.keys.serverToClient,
            },
            payload,
        );
    }

    #sendSealed(
        socket: WebSocket,
        session: GatewaySession,
        payload: unknown,
        onSent?: (error?: Error) => void,
    ): void {
        const sourceFrame = this.#sealedPayload(session, payload);
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
        const sourceFrame = this.#sealedPayload(session, revoked);
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

    /**
     * Server decisions win over the close code: a `terminate()` reaches the close handler as 1006, the same code a lost
     * network produces. 1006 without a Server decision means no close frame arrived from the phone.
     */
    #connectionEnd(
        socket: WebSocket,
        session: GatewaySession,
        serverEnd: MobileConnectionEnd | undefined,
        closeCode: number,
    ): MobileConnectionEnd {
        if (session.revoking) return { cause: 'revoked' };
        if (this.#disabledSockets.has(socket)) return { cause: 'gateway-disabled' };
        if (serverEnd) return serverEnd;
        if (closeCode === 1_006) return { cause: 'peer-dropped' };
        const clientReason = mobileClientCloseReasonOf(closeCode);
        return {
            cause: 'peer-closed',
            closeCode,
            ...(clientReason !== undefined && { clientReason }),
        };
    }
}
/* eslint-enable unicorn/consistent-class-member-order */
