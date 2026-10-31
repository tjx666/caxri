/**
 * One authenticated gateway connection: the ordered reader, request and subscription replies, liveness, and the
 * hand-over back to a direct route.
 */
import type {
    MobileClientCloseReason,
    MobileClientPayload,
    MobileSubscriptionResource,
} from '@caxri/mobile-transport';
import {
    encodeHex,
    mobileClientCloseReasons,
    mobileServerPayloadSchema,
    mobileSubscribeResultSchema,
    mobileUnsubscribeResultSchema,
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
import { DirectRouteProbe } from './direct-route-probe';
import type { MobileGatewayRouteKind } from './gateway-routes';
import type { MobileSubscriptionListener } from './mobile-frame-router';
import { MobileFrameRouter } from './mobile-frame-router';
import { MobileGatewayRequestError, MobileGatewayTimeoutError } from './mobile-gateway-errors';
import type { EstablishedSession } from './mobile-gateway-session';
import { HANDSHAKE_TIMEOUT_MS, receiveSealed, sendSealed } from './mobile-gateway-session';
import { MobileHeartbeat } from './mobile-heartbeat';
import { isFastMobileRead } from './mobile-read-timeouts';
import { connectionClosedError } from './socket-reader';

const READ_REQUEST_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;
const FOREGROUND_PROBE_TIMEOUT_MS = 1_500;

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

/**
 * The `ready` a reconnect still waits for when its connection is handed out right after the handshake `confirm`.
 */
interface ExpectedReady {
    deviceId: string;
    generation: number;
    onReady(): void;
}

export interface MobileGatewayConnectionOptions {
    /**
     * Checks the paired computer's direct addresses; only a Relay session uses it, to move back to a direct path.
     */
    directProbe?: () => Promise<boolean>;
    /**
     * Set by a reconnect, which hands the connection out without waiting for `ready`, so the first requests travel
     * right behind the `confirm` instead of one round trip later. The Server answers them only after `ready`; a
     * missing, late, or foreign `ready` ends the connection.
     */
    expectReady?: ExpectedReady;
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
    #expectedReady?: ExpectedReady;
    #isForeground = false;
    #outstandingMutations = 0;
    #readyTimer?: ReturnType<typeof setTimeout>;
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
        if (options.expectReady) {
            this.#expectedReady = options.expectReady;
            this.#readyTimer = setTimeout(
                () =>
                    this.#finish(
                        'disconnected',
                        new Error('Caxri did not confirm the connection in time.'),
                        'ready-timeout',
                    ),
                HANDSHAKE_TIMEOUT_MS,
            );
        }
        void this.#readLoop();
    }

    #acceptReady(expected: ExpectedReady, raw: unknown): void {
        const ready = mobileReadySchema.parse(raw);
        if (ready.deviceId !== expected.deviceId || ready.generation !== expected.generation)
            throw new Error('Caxri returned an unexpected device identity.');
        clearTimeout(this.#readyTimer);
        this.#expectedReady = undefined;
        expected.onReady();
    }

    #finish(
        reason: MobileGatewayTermination,
        error: Error,
        closeReason: MobileClientCloseReason,
    ): void {
        if (this.#termination || this.#closedByOwner) return;
        this.#termination = reason;
        clearTimeout(this.#readyTimer);
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
                const raw = await receiveSealed(this.#session);
                if (this.#expectedReady) this.#acceptReady(this.#expectedReady, raw);
                // eslint-disable-next-line no-await-in-loop -- revocation clears the credential before the next frame.
                else if ((await this.#receivePayload(raw)) === 'revoked') return;
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

    async #receivePayload(raw: unknown): Promise<'continue' | 'revoked'> {
        const payload = mobileServerPayloadSchema.parse(raw);
        if (payload.type === 'revoked') {
            if (
                payload.deviceId !== this.#session.deviceId ||
                payload.generation !== this.#session.generation
            )
                throw new Error('Caxri returned an unexpected revoked identity.');
            // A credential is cleared only after the control payload has passed authenticated frame opening.
            await this.#clearCredential();
            this.#finish('revoked', new Error('This device was revoked.'), 'superseded');
            return 'revoked';
        }
        if (payload.type === 'reply') this.#router.receiveReply(payload.reply);
        else if (payload.type === 'heartbeat-ack') this.#heartbeat.acknowledge(payload.nonce);
        else this.#router.receiveSubscriptionMessage(payload);
        return 'continue';
    }

    async #sendWithReply(
        id: string,
        payload: MobileClientPayload,
        timeoutMs: number,
        kind: 'mutation' | 'read' | 'subscription',
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
                // A late read only rejects itself: a computer whose Server is starved of CPU answers seconds late over
                // a socket that still works, so the owner hedges with a replacement and the heartbeat judges this one.
                // A missed subscription acknowledgement still ends the connection, because the Server may hold a
                // subscription this client can no longer route.
                if (kind === 'mutation') this.#deferredMutation = deferred;
                else if (kind === 'read') return;
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
        clearTimeout(this.#readyTimer);
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
                isFastRead ? 'read' : 'mutation',
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
                'subscription',
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
                        'subscription',
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

    /**
     * Asks for a quick answer after a wake. A late answer rejects the probe but leaves the connection open: the owner
     * dials a replacement and keeps whichever proves alive first.
     */
    async probe(): Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.request('mobile.dashboard'),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error('Caxri did not respond to the foreground probe.')),
                        FOREGROUND_PROBE_TIMEOUT_MS,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timeout);
        }
    }
}
