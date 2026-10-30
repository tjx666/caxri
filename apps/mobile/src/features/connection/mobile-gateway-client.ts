import type {
    MobileClientCloseReason,
    MobileClientPayload,
    MobileSubscriptionResource,
} from '@caxri/mobile-transport';
import {
    decodeHex,
    encodeHex,
    HANDSHAKE_NONCE_BYTES,
    MOBILE_TRANSPORT_VERSION,
    mobileClientCloseReasons,
    mobilePairingResultSchema,
    mobilePublicKey,
    mobileServerPayloadSchema,
    mobileSubscribeResultSchema,
    mobileUnsubscribeResultSchema,
    PAIRING_SECRET_BYTES,
    parseMobilePairingLink,
    X25519_KEY_BYTES,
} from '@caxri/mobile-transport';
import type {
    CaxriMethod,
    CommandReplyEnvelope,
    MethodResult,
    ParametersArgument,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    mobileDeviceIdSchema,
    parseCaxriResult,
    requestEnvelopeSchema,
} from '@caxri/protocol';
import { z } from 'zod';

import { notifyListeners } from '../../lib/notify-listeners';
import type { MobileCredential, MobileCredentialStore } from './credential-store';
import { DirectRouteProbe } from './direct-route-probe';
import type { MobileGatewayRouteKind } from './gateway-routes';
import { isDirectRouteReachable, pairedGatewayRoutes } from './gateway-routes';
import type { MobileSubscriptionListener } from './mobile-frame-router';
import { MobileFrameRouter } from './mobile-frame-router';
import {
    MobileGatewayRequestError,
    MobileGatewayTimeoutError,
    MobilePairingError,
    MobileReconnectError,
    MobileServerVerificationError,
    MobileVersionMismatchError,
} from './mobile-gateway-errors';
import type { EstablishedSession } from './mobile-gateway-session';
import {
    establish,
    HANDSHAKE_TIMEOUT_MS,
    receiveSealed,
    sendSealed,
} from './mobile-gateway-session';
import { MobileHeartbeat } from './mobile-heartbeat';
import { isFastMobileRead } from './mobile-read-timeouts';
import { pairingClientHello } from './pairing-client-hello';
import { pairingCredential } from './pairing-credential';
import { createPairingSocketRuntime } from './pairing-socket-runtime';
import type { MobileRouteHints } from './route-hints';
import { reconnectDirectGrace } from './route-hints';
import { connectionClosedError } from './socket-reader';

const READ_REQUEST_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;
const FOREGROUND_PROBE_TIMEOUT_MS = 1_500;

export {
    MobileGatewayRequestError,
    MobileGatewayTimeoutError,
    MobilePairingError,
    MobileReconnectError,
    MobileVersionMismatchError,
} from './mobile-gateway-errors';

export interface MobileGatewayRuntime {
    openWebSocket(url: string): WebSocket;
    platform: 'android' | 'ios';
    randomBytes(length: number): Uint8Array;
    /**
     * Whether the phone is on cellular data, where home LAN addresses cannot answer; absent in tests.
     */
    isCellular?: () => Promise<boolean>;
    /**
     * Shortens the direct-only head start when the Relay won last time; absent while pairing and in tests.
     */
    routeHints?: MobileRouteHints;
}

const mobileReadySchema = z.strictObject({
    type: z.literal('ready'),
    deviceId: mobileDeviceIdSchema,
    generation: z.number().int().positive(),
});

/**
 * How a connection ended. `route-upgrade` is a planned hand-over from the Relay to a direct route, not a loss: the
 * owner reconnects without showing the connection as lost.
 */
export type MobileGatewayTermination = 'disconnected' | 'revoked' | 'route-upgrade';

/**
 * A liveness or mutation failure held back while a mutation is outstanding, with the close reason it ends with.
 */
interface DeferredFailure {
    error: Error;
    reason: MobileClientCloseReason;
}

/**
 * Closes with the phone's reason as a private close code, the only way it reaches the Server log.
 */
const closeSocketFor = (socket: WebSocket, reason: MobileClientCloseReason): void => {
    socket.close(mobileClientCloseReasons[reason], reason);
};

export interface MobileGatewaySubscriptionHandle {
    subscriptionId: string;
    unsubscribe(): Promise<void>;
}

export interface MobileGatewayConnectionOptions {
    /**
     * Checks the paired computer's direct addresses; only a Relay session uses it, to move back to a direct path.
     */
    directProbe?: () => Promise<boolean>;
}

export class MobileGatewayConnection {
    readonly #clearCredential: () => Promise<void>;
    readonly #directRoute?: DirectRouteProbe;
    readonly #heartbeat: MobileHeartbeat;
    readonly #listeners = new Set<(reason: MobileGatewayTermination) => void>();
    readonly #observationListeners = new Set<() => void>();
    readonly #router = new MobileFrameRouter();
    readonly #session: EstablishedSession;
    #closedByOwner = false;
    #deferredLiveness?: DeferredFailure;
    /**
     * A timed-out mutation may have reached the server; later traffic cannot make retry safe.
     */
    #deferredMutation?: DeferredFailure;
    #isForeground = false;
    #outstandingMutations = 0;
    #termination?: MobileGatewayTermination;

    constructor(
        session: EstablishedSession,
        clearCredential: () => Promise<void>,
        options: MobileGatewayConnectionOptions = {},
    ) {
        this.#session = session;
        this.#clearCredential = clearCredential;
        if (session.route === 'relay' && options.directProbe)
            this.#directRoute = new DirectRouteProbe({
                probe: options.directProbe,
                readyAt: Date.now(),
                canUpgrade: () => !this.hasOutstandingMutation(),
                // The owner's reconnect path tries direct routes first again, while it keeps showing "connected".
                onUpgrade: () =>
                    this.#finish(
                        'route-upgrade',
                        new Error('A direct route to Caxri is available.'),
                        'route-upgrade',
                    ),
            });
        this.#heartbeat = new MobileHeartbeat({
            onTimeout: () => {
                const error = new Error('Caxri did not acknowledge the heartbeat.');
                if (this.hasOutstandingMutation())
                    this.#deferredLiveness = { error, reason: 'heartbeat-timeout' };
                else this.#finish('disconnected', error, 'heartbeat-timeout');
            },
            randomBytes: (size) => session.runtime.randomBytes(size),
            send: (payload) => sendSealed(session, payload),
        });
        void this.#readLoop();
    }

    #finish(
        reason: MobileGatewayTermination,
        error: Error,
        closeReason: MobileClientCloseReason,
    ): void {
        if (this.#termination || this.#closedByOwner) return;
        this.#termination = reason;
        this.#heartbeat.stop();
        this.#directRoute?.stop();
        this.#router.rejectAll(error);
        this.#session.reader.close();
        closeSocketFor(this.#session.socket, closeReason);
        // Isolates each termination subscriber so one throwing screen cannot stop the rest from observing this
        // connection's termination. Mobile has no structured-log sink to report into yet, so the failure is isolated
        // silently rather than reported.
        notifyListeners(this.#listeners, reason);
    }

    /**
     * Owns the only post-handshake reader so authenticated control payloads cannot race command replies or socket
     * closure. Credential deletion occurs inside this ordered boundary before the revoked terminal state is exposed.
     */
    async #readLoop(): Promise<void> {
        try {
            while (!this.#termination && !this.#closedByOwner) {
                // eslint-disable-next-line no-await-in-loop -- one reader serializes and authenticates every server frame.
                const payload = mobileServerPayloadSchema.parse(await receiveSealed(this.#session));
                if (payload.type === 'revoked') {
                    if (
                        payload.deviceId !== this.#session.deviceId ||
                        payload.generation !== this.#session.generation
                    )
                        throw new Error('Caxri returned an unexpected revoked identity.');
                    // A credential is cleared only after the control payload has passed authenticated frame opening.
                    // eslint-disable-next-line no-await-in-loop -- revocation is the terminal frame for this connection.
                    await this.#clearCredential();
                    this.#finish('revoked', new Error('This device was revoked.'), 'superseded');
                    return;
                }
                if (payload.type === 'reply') this.#router.receiveReply(payload.reply);
                else if (payload.type === 'heartbeat-ack')
                    this.#heartbeat.acknowledge(payload.nonce);
                else this.#router.receiveSubscriptionMessage(payload);
                this.#deferredLiveness = undefined;
                if (this.#isForeground) this.#heartbeat.start();
                // Isolates each observation subscriber so one throwing screen cannot stop the rest from observing this
                // frame; Mobile has no structured-log sink to report into yet, so the failure is isolated silently.
                notifyListeners(this.#observationListeners, undefined);
            }
        } catch (error) {
            // A peer close also lands here; closing an already closed socket again sends nothing.
            this.#finish(
                'disconnected',
                error instanceof Error ? error : new Error('The Caxri connection closed.'),
                'protocol-error',
            );
        }
    }

    async #sendWithReply(
        id: string,
        payload: MobileClientPayload,
        timeoutMs: number,
        isMutation = false,
    ): Promise<CommandReplyEnvelope> {
        if (this.#termination || this.#closedByOwner) throw connectionClosedError();
        if (this.#deferredMutation) throw this.#deferredMutation.error;
        const timeoutError = new MobileGatewayTimeoutError();
        const response = this.#router.waitForReply(
            id,
            timeoutMs,
            () => {
                const deferred: DeferredFailure = {
                    error: timeoutError,
                    reason: 'request-timeout',
                };
                if (isMutation) this.#deferredMutation = deferred;
                else if (this.hasOutstandingMutation()) this.#deferredLiveness = deferred;
                else this.#finish('disconnected', timeoutError, 'request-timeout');
            },
            timeoutError,
        );
        try {
            sendSealed(this.#session, payload);
        } catch (error) {
            this.#finish(
                'disconnected',
                error instanceof Error ? error : new Error('The Caxri connection closed.'),
                'send-failed',
            );
        }
        return response;
    }

    /**
     * Ends the connection for its owner; `reason` says why, so the Server log can tell an app reset from a reconnect.
     */
    close(reason: MobileClientCloseReason): void {
        if (!this.#closedByOwner && !this.#termination)
            closeSocketFor(this.#session.socket, reason);
        this.#closedByOwner = true;
        this.#heartbeat.stop();
        this.#directRoute?.stop();
        this.#router.rejectAll(connectionClosedError());
        this.#session.reader.close();
        this.#listeners.clear();
        this.#observationListeners.clear();
    }

    onTermination(listener: (reason: MobileGatewayTermination) => void): () => void {
        if (this.#termination) {
            listener(this.#termination);
            return () => {};
        }
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    onObservation(listener: () => void): () => void {
        this.#observationListeners.add(listener);
        return () => this.#observationListeners.delete(listener);
    }

    /**
     * The path this connection runs over.
     */
    get route(): MobileGatewayRouteKind {
        return this.#session.route;
    }

    setForeground(isForeground: boolean): void {
        this.#isForeground = isForeground;
        if (isForeground && !this.#closedByOwner && !this.#termination) {
            this.#heartbeat.start();
            this.#directRoute?.start();
        } else {
            this.#heartbeat.stop();
            this.#directRoute?.stop();
        }
    }

    hasOutstandingMutation(): boolean {
        return this.#outstandingMutations > 0;
    }

    async request<M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodResult<M>> {
        const isFastRead = isFastMobileRead(method);
        if (!isFastRead) this.#outstandingMutations += 1;
        try {
            const id = `mobile_${encodeHex(this.#session.runtime.randomBytes(16))}`;
            const reply = await this.#sendWithReply(
                id,
                {
                    type: 'request',
                    request: requestEnvelopeSchema.parse({
                        protocolVersion: CAXRI_PROTOCOL_VERSION,
                        id,
                        method,
                        params: arguments_[0] ?? {},
                    }),
                },
                isFastRead ? READ_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
                !isFastRead,
            );
            if (!reply.ok)
                throw new MobileGatewayRequestError(reply.error.code, reply.error.message);
            return parseCaxriResult(method, reply.result);
        } finally {
            if (!isFastRead) {
                this.#outstandingMutations -= 1;
                if (!this.hasOutstandingMutation()) {
                    const deferred = this.#deferredMutation ?? this.#deferredLiveness;
                    if (deferred) this.#finish('disconnected', deferred.error, deferred.reason);
                }
            }
        }
    }

    /**
     * Sends the subscribe frame before returning its first promise tick, so a read issued right after it travels behind
     * it on the same socket. Several subscriptions may await acknowledgement at once.
     */
    async subscribe(
        resource: MobileSubscriptionResource,
        listener: MobileSubscriptionListener,
    ): Promise<MobileGatewaySubscriptionHandle> {
        let id: string | undefined;
        try {
            id = `mobile_${encodeHex(this.#session.runtime.randomBytes(16))}`;
            this.#router.beginSubscriptionRequest(id);
            const reply = await this.#sendWithReply(
                id,
                { type: 'subscribe', id, resource },
                READ_REQUEST_TIMEOUT_MS,
            );
            if (!reply.ok)
                throw new MobileGatewayRequestError(reply.error.code, reply.error.message);
            const { subscriptionId } = mobileSubscribeResultSchema.parse(reply.result);
            if (this.#termination || this.#closedByOwner) throw connectionClosedError();
            this.#router.addSubscription(subscriptionId, resource, listener);
            let didUnsubscribe = false;
            return {
                subscriptionId,
                unsubscribe: async () => {
                    if (didUnsubscribe) return;
                    didUnsubscribe = true;
                    const isActive = this.#router.hasSubscription(subscriptionId);
                    this.#router.removeSubscription(subscriptionId);
                    if (!isActive || this.#termination || this.#closedByOwner) return;
                    const unsubscribeId = `mobile_${encodeHex(this.#session.runtime.randomBytes(16))}`;
                    const unsubscribeReply = await this.#sendWithReply(
                        unsubscribeId,
                        { type: 'unsubscribe', id: unsubscribeId, subscriptionId },
                        READ_REQUEST_TIMEOUT_MS,
                    );
                    if (!unsubscribeReply.ok)
                        throw new MobileGatewayRequestError(
                            unsubscribeReply.error.code,
                            unsubscribeReply.error.message,
                        );
                    mobileUnsubscribeResultSchema.parse(unsubscribeReply.result);
                },
            };
        } finally {
            if (id) this.#router.endSubscriptionRequest(id);
        }
    }

    async probe(): Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.request('mobile.dashboard'),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => {
                        const error = new Error('Caxri did not respond to the foreground probe.');
                        if (this.hasOutstandingMutation())
                            this.#deferredLiveness = { error, reason: 'probe-timeout' };
                        else this.#finish('disconnected', error, 'probe-timeout');
                        reject(error);
                    }, FOREGROUND_PROBE_TIMEOUT_MS);
                }),
            ]);
        } finally {
            clearTimeout(timeout);
        }
    }
}

export interface PairedMobileConnection {
    connection: MobileGatewayConnection;
    credential: MobileCredential;
}

const hasUnsupportedPairingLinkVersion = (source: string): boolean => {
    try {
        const url = new URL(source);
        if (url.protocol !== 'caxri:' || url.hostname !== 'pair') return false;
        const versionText = url.searchParams.get('v');
        if (versionText === null) return false;
        const version = Number(versionText);
        if (!Number.isSafeInteger(version)) return false;
        return version !== MOBILE_TRANSPORT_VERSION;
    } catch {
        return false;
    }
};

const directProbeOptions = (
    credential: MobileCredential,
    runtime: MobileGatewayRuntime,
): MobileGatewayConnectionOptions => ({
    directProbe: () => isDirectRouteReachable(credential.addresses, credential.port, runtime),
});

export const pairMobileGateway = async (input: {
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    displayName: string;
    pairingLink: string;
    runtime: MobileGatewayRuntime;
    store: MobileCredentialStore;
}): Promise<PairedMobileConnection> => {
    let link: ReturnType<typeof parseMobilePairingLink>;
    try {
        link = parseMobilePairingLink(input.pairingLink);
    } catch {
        if (hasUnsupportedPairingLinkVersion(input.pairingLink))
            throw new MobileVersionMismatchError();
        throw new MobilePairingError('invalid-link', 'This is not a Caxri pairing link.');
    }
    if (link.expiresAt <= Date.now())
        throw new MobilePairingError('expired', 'This pairing code has expired.');
    const clientSecretKey = input.runtime.randomBytes(X25519_KEY_BYTES);
    const clientNonce = input.runtime.randomBytes(HANDSHAKE_NONCE_BYTES);
    const { runtime, dispose } = createPairingSocketRuntime(input.runtime, input.signal);
    let session: EstablishedSession;
    try {
        session = await establish({
            routes: pairedGatewayRoutes({ ...link, purpose: 'pairing', secret: link.secret }),
            mode: 'pair',
            expectedServerId: link.serverId,
            clientSecretKey,
            clientNonce,
            presharedKey: decodeHex(link.secret, PAIRING_SECRET_BYTES),
            runtime,
            clientHello: pairingClientHello({
                pairingId: link.pairingId,
                displayName: input.displayName,
                platform: input.runtime.platform,
                clientSecretKey,
                clientNonce,
            }),
        });
    } catch (error) {
        dispose();
        if (error instanceof MobilePairingError || error instanceof MobileVersionMismatchError)
            throw error;
        throw new MobilePairingError('rejected', 'Caxri could not verify this pairing.');
    }
    try {
        const paired = mobilePairingResultSchema.parse(
            await receiveSealed(session, HANDSHAKE_TIMEOUT_MS),
        );
        if (paired.deviceId !== session.deviceId)
            throw new Error('Caxri returned an unexpected device identity.');
        const credential = pairingCredential(link, paired);
        await input.store.save(
            credential,
            () => !input.signal?.aborted && (input.isCurrent?.() ?? true),
        );
        if (input.signal?.aborted) throw new Error('Pairing attempt was cancelled.');
        dispose();
        return {
            connection: new MobileGatewayConnection(
                session,
                async () => {
                    await input.store.clearIfCurrent(credential);
                },
                directProbeOptions(credential, input.runtime),
            ),
            credential,
        };
    } catch (error) {
        dispose();
        session.reader.close();
        session.socket.close();
        throw error;
    }
};

export const reconnectMobileGateway = async (
    credential: MobileCredential,
    runtime: MobileGatewayRuntime,
    store: MobileCredentialStore,
): Promise<MobileGatewayConnection> => {
    const clientSecretKey = runtime.randomBytes(X25519_KEY_BYTES);
    const clientNonce = runtime.randomBytes(HANDSHAKE_NONCE_BYTES);
    const directGraceMs = await reconnectDirectGrace({ ...runtime, ...credential });
    let session: EstablishedSession;
    try {
        session = await establish({
            directGraceMs,
            routes: pairedGatewayRoutes({
                ...credential,
                purpose: 'device',
                secret: credential.credential,
            }),
            mode: 'connect',
            expectedServerId: credential.serverId,
            clientSecretKey,
            clientNonce,
            presharedKey: decodeHex(credential.credential, PAIRING_SECRET_BYTES),
            runtime,
            clientHello: {
                type: 'hello',
                version: MOBILE_TRANSPORT_VERSION,
                mode: 'connect',
                deviceId: credential.deviceId,
                generation: credential.generation,
                clientPublicKey: encodeHex(mobilePublicKey(clientSecretKey)),
                clientNonce: encodeHex(clientNonce),
            },
        });
    } catch (error) {
        if (error instanceof MobileServerVerificationError) throw new MobileReconnectError();
        throw error;
    }
    try {
        const ready = mobileReadySchema.parse(await receiveSealed(session, HANDSHAKE_TIMEOUT_MS));
        if (ready.deviceId !== credential.deviceId || ready.generation !== credential.generation)
            throw new Error('Caxri returned an unexpected device identity.');
        runtime.routeHints?.save(credential.serverId, session.route);
        return new MobileGatewayConnection(
            session,
            async () => {
                await store.clearIfCurrent(credential);
            },
            directProbeOptions(credential, runtime),
        );
    } catch (error) {
        session.reader.close();
        session.socket.close();
        throw error;
    }
};
