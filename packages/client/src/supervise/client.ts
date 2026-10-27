import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import type {
    BinaryStreamOperation,
    BinaryStreamTicketGrant,
    CaxriMethod,
    DesktopLease,
    DesktopLeaseRevocationReason,
    DesktopServerOperation,
    DesktopServerOperationArguments,
    DesktopServerOperationResult,
    DesktopTargetPayload,
    LocalServerDesktopCommand,
    LocalServerEvent,
    MethodResult,
    ParametersArgument,
    ProtocolWelcome,
    ServerControlEndpoint,
    ServerManifest,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    CONTROL_TRANSPORT_MAX_FRAME_BYTES,
    desktopTargetPayloadSchema,
    fromWireError,
    isNonExpiringServerOperation,
    localClientDesktopReadySchema,
    localClientDesktopReplySchema,
    localServerDesktopCommandSchema,
    localServerDesktopLeaseRevokedSchema,
    localServerDesktopOperationReplySchema,
    localServerDesktopTargetReplySchema,
    localServerEventSchema,
    localServerLeaseRenewedSchema,
    localServerReplySchema,
    localServerStreamTicketReplySchema,
    parseCaxriRequest,
    parseCaxriResult,
    parseServerOperationRequest,
    parseServerOperationResult,
    toWireError,
} from '@caxri/protocol';
import { notifyListeners, notifyListenersThenRethrow } from '@caxri/utils';
import WebSocket from 'ws';

import { BinaryStreamClient } from './binary-stream-client.js';
import { openServerHandshake } from './client-handshake.js';
import type { PendingRequest, ServerClientCredential } from './client-support.js';
import { controlMessageText, DEFAULT_TIMEOUT_MS } from './client-support.js';

// Re-exported so `@caxri/client/supervise` consumers keep importing this type from `client.js`, unchanged by the
// `client-support.js` split.
export type { ServerClientCredential } from './client-support.js';

/**
 * Interval between background Desktop lease renewals. Kept well under Server Core's `DESKTOP_LEASE_MS` (60s,
 * `apps/server/src/core/control-server-support.ts`) so a normally running Desktop renews several times per lease
 * window. `renewLeaseNow` exists because this interval alone is not enough across a macOS sleep/wake cycle: both
 * processes suspend together, so a timer that was due mid-sleep only fires once the process resumes, and Server Core's
 * independently-suspended 60s lease timer can win that race. See `DESKTOP_LEASE_GRACE_MS` on the Server side for the
 * other half of this fix.
 */
const DESKTOP_LEASE_RENEW_MS = 20_000;

/**
 * Authenticated local client shared by the CLI command surface and its future Agent adapter.
 */
export class ServerClient {
    static async connect(
        manifest: ServerManifest,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        credential?: ServerClientCredential,
    ): Promise<ServerClient> {
        const {
            deferredMessages,
            desktopLease,
            handshakeMessageListener,
            resolvedCredential,
            socket,
            welcome,
        } = await openServerHandshake(manifest, timeoutMs, credential);
        const client = new ServerClient(
            socket,
            welcome,
            timeoutMs,
            desktopLease,
            resolvedCredential.kind === 'desktop'
                ? (operation, consumeTarget) =>
                      resolvedCredential.handleCommand(operation, consumeTarget)
                : undefined,
            manifest.version,
            manifest.endpoint,
        );
        if (handshakeMessageListener) socket.removeListener('message', handshakeMessageListener);
        for (const message of deferredMessages) {
            if (message.isBinary) client.closeTransport();
            else client.receive(controlMessageText(message.data));
        }
        socket.resume();
        return client;
    }

    private readonly eventListeners = new Set<(event: LocalServerEvent['event']) => void>();
    private readonly closeListeners = new Set<
        (reason?: DesktopLeaseRevocationReason, closeCode?: number) => void
    >();
    private readonly binaryStreams?: BinaryStreamClient;
    private readonly pending = new Map<string, PendingRequest>();
    private closed = false;
    /**
     * Raw WebSocket close code captured off the socket's own `close` event, kept only for diagnostics (see
     * `server_connection.lost` in `apps/desktop/src/main/server-connection.ts`). Absent when this side closed the
     * connection deliberately before any close frame arrived.
     */
    private closeCode?: number;
    private closeReason?: DesktopLeaseRevocationReason;
    private leaseRenewalTimer?: NodeJS.Timeout;
    desktopLease?: DesktopLease;

    private constructor(
        private readonly socket: WebSocket,
        readonly welcome: ProtocolWelcome,
        private readonly timeoutMs: number,
        desktopLease?: DesktopLease,
        private readonly desktopCommandHandler?: Extract<
            ServerClientCredential,
            { kind: 'desktop' }
        >['handleCommand'],
        readonly serverVersion?: string,
        endpoint?: ServerControlEndpoint,
    ) {
        this.desktopLease = desktopLease;
        if (endpoint && welcome.features?.includes('binary-streams-v1')) {
            this.binaryStreams = new BinaryStreamClient({
                emitEvent: (event) => notifyListenersThenRethrow(this.eventListeners, event),
                endpoint,
                issueTicket: (id, operation) => this.issueStreamTicket(id, operation),
                onTerminalTransportFailure: () => this.closeTransport(),
                timeoutMs,
            });
        }
        socket.on('message', (data, isBinary) => {
            if (isBinary) this.closeTransport();
            else this.receive(controlMessageText(data));
        });
        socket.on('close', (code) => {
            this.closeCode = code;
            this.failPending();
        });
        socket.on('error', () => this.failPending());
        if (desktopLease) {
            this.leaseRenewalTimer = setInterval(
                () => this.renewDesktopLease(),
                DESKTOP_LEASE_RENEW_MS,
            );
            this.leaseRenewalTimer.unref();
        }
    }

    private receive(message: string): void {
        try {
            const raw = JSON.parse(message) as unknown;
            const renewed = localServerLeaseRenewedSchema.safeParse(raw);
            const revoked = localServerDesktopLeaseRevokedSchema.safeParse(raw);
            const event = localServerEventSchema.safeParse(raw);
            const streamTicket = localServerStreamTicketReplySchema.safeParse(raw);
            if (streamTicket.success) {
                const pending = this.pending.get(streamTicket.data.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(streamTicket.data.id);
                    if (streamTicket.data.ok)
                        pending.resolve(pending.parse(streamTicket.data.grant));
                    else pending.reject(fromWireError(streamTicket.data.error));
                }
            } else if (renewed.success) {
                if (
                    !this.desktopLease ||
                    renewed.data.lease.desktopId !== this.desktopLease.desktopId ||
                    renewed.data.lease.generation !== this.desktopLease.generation
                )
                    throw new Error('Desktop lease renewal does not match this connection');
                this.desktopLease = renewed.data.lease;
            } else if (revoked.success) {
                if (!this.desktopLease || revoked.data.generation !== this.desktopLease.generation)
                    throw new Error('Desktop lease revocation does not match this connection');
                this.closeReason = revoked.data.reason;
                this.failPending();
                this.socket.close(1000);
                return;
            } else if (event.success) {
                notifyListenersThenRethrow(this.eventListeners, event.data.event);
            } else {
                const desktopCommand = localServerDesktopCommandSchema.safeParse(raw);
                if (desktopCommand.success) {
                    // `receive` is a synchronous socket data handler; the reply is written
                    // asynchronously from within `handleDesktopCommand` itself, so this call is
                    // intentionally fire-and-forget here.
                    void this.handleDesktopCommand(desktopCommand.data);
                    return;
                }
                const runtimeReply = localServerDesktopOperationReplySchema.safeParse(raw);
                const targetReply = localServerDesktopTargetReplySchema.safeParse(raw);
                const { reply } = runtimeReply.success
                    ? runtimeReply.data
                    : targetReply.success
                      ? targetReply.data
                      : localServerReplySchema.parse(raw);
                if (!reply.id) throw new Error('Reply is missing its request ID');
                const pending = this.pending.get(reply.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(reply.id);
                    if (reply.ok) pending.resolve(pending.parse(reply.result));
                    else pending.reject(fromWireError(reply.error));
                }
            }
        } catch {
            this.closeTransport();
        }
    }

    private async handleDesktopCommand(command: LocalServerDesktopCommand): Promise<void> {
        const lease = this.desktopLease;
        let result: unknown;
        let error: unknown;
        try {
            if (
                !lease ||
                lease.desktopId !== command.lease.desktopId ||
                lease.generation !== command.lease.generation
            )
                throw new CaxriError('CONFLICT', 'Desktop capability lease is stale');
            if (!this.desktopCommandHandler)
                throw new CaxriError('UNAVAILABLE', 'Desktop command handler is unavailable');
            result = await this.desktopCommandHandler(command.request.operation, () => {
                if (!('targetId' in command.request.operation))
                    return Promise.reject(
                        new CaxriError('VALIDATION', 'Desktop command has no opaque target'),
                    );
                return this.consumeDesktopTarget(command.request.operation.targetId);
            });
        } catch (error_) {
            error = error_;
        }
        if (this.closed) return;
        const reply = error
            ? {
                  protocolVersion: CAXRI_PROTOCOL_VERSION,
                  id: command.request.id,
                  ok: false as const,
                  error: toWireError(error),
              }
            : {
                  protocolVersion: CAXRI_PROTOCOL_VERSION,
                  id: command.request.id,
                  ok: true as const,
                  result: result ?? null,
              };
        const message = localClientDesktopReplySchema.parse({
            type: 'desktop-reply',
            generation: command.lease.generation,
            reply,
        });
        this.send(message);
    }

    private consumeDesktopTarget(targetId: string): Promise<DesktopTargetPayload> {
        const lease = this.desktopLease;
        if (!lease) return Promise.reject(new CaxriError('FORBIDDEN', 'Desktop lease is required'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CaxriError('TIMEOUT', 'Desktop target redemption timed out'));
            }, this.timeoutMs);
            this.pending.set(id, {
                parse: (value) => desktopTargetPayloadSchema.parse(value),
                resolve: (value) => resolve(value as DesktopTargetPayload),
                reject,
                timer,
            });
            this.send({
                type: 'desktop-target.consume',
                generation: lease.generation,
                id,
                targetId,
            });
        });
    }

    private closeTransport(): void {
        this.failPending();
        this.socket.terminate();
    }

    private failPending(
        error = this.closeReason === 'replaced'
            ? new CaxriError('CANCELLED', 'Caxri Desktop lease was replaced')
            : new CaxriError('UNAVAILABLE', 'Caxri Server connection closed'),
    ): void {
        if (this.closed) return;
        this.closed = true;
        if (this.leaseRenewalTimer) clearInterval(this.leaseRenewalTimer);
        this.leaseRenewalTimer = undefined;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.binaryStreams?.close(error);
        const listeners = [...this.closeListeners];
        this.closeListeners.clear();
        // `notifyListeners` isolates each close listener so a throwing one cannot stop the rest from observing this
        // connection's close; this class has no injected logger, so a failure is isolated silently here rather than
        // reported, matching this file's existing `notifyListenersThenRethrow` event delivery (no reporter either).
        notifyListeners(
            listeners.map((listener) => () => listener(this.closeReason, this.closeCode)),
            undefined,
        );
    }

    /**
     * Sends the Desktop lease renewal frame; shared by the background interval and `renewLeaseNow`.
     */
    private renewDesktopLease(): void {
        const generation = this.desktopLease?.generation;
        if (!generation || this.closed) return;
        this.send({ type: 'desktop-lease.renew', generation });
    }

    private send(message: unknown, settled?: (error?: Error) => void): void {
        const source = JSON.stringify(message);
        const sourceBytes = Buffer.byteLength(source, 'utf8');
        if (
            this.socket.readyState !== WebSocket.OPEN ||
            this.socket.bufferedAmount + sourceBytes > CONTROL_TRANSPORT_MAX_FRAME_BYTES
        ) {
            const error = new CaxriError('UNAVAILABLE', 'Caxri Server connection is unavailable');
            settled?.(error);
            this.closeTransport();
            return;
        }
        this.socket.send(source, (error) => {
            settled?.(error);
            if (error) this.closeTransport();
        });
    }

    private issueStreamTicket(
        id: string,
        operation: BinaryStreamOperation,
    ): Promise<BinaryStreamTicketGrant> {
        if (this.closed)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Caxri Server connection is closed'),
            );
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new CaxriError(
                        'TIMEOUT',
                        `Caxri Server stream ticket timed out: ${operation.method}`,
                    ),
                );
            }, this.timeoutMs);
            this.pending.set(id, {
                parse: (value) => value,
                resolve: (value) => resolve(value as BinaryStreamTicketGrant),
                reject,
                timer,
            });
            this.send({
                type: 'stream-ticket.request',
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id,
                operation,
            });
        });
    }

    private sendRequest(id: string, method: CaxriMethod, parameters: unknown): Promise<unknown> {
        if (this.closed)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Caxri Server connection is closed'),
            );
        const request = parseCaxriRequest(method, parameters);
        if (this.binaryStreams?.supports(request.method))
            return this.binaryStreams.request(id, request.method, request.params);
        const detachTransition =
            request.method === 'terminal.detach'
                ? this.binaryStreams?.beginTerminalDetach(request.params.terminalId)
                : undefined;
        const completeTerminalLifecycle =
            request.method === 'terminal.detach'
                ? () => detachTransition?.complete()
                : request.method === 'terminal.close'
                  ? () => this.binaryStreams?.closeTerminal(request.params.terminalId)
                  : undefined;
        return new Promise<unknown>((resolve, reject) => {
            const timer = isNonExpiringServerOperation(method)
                ? undefined
                : setTimeout(() => {
                      this.pending.delete(id);
                      detachTransition?.cancel();
                      reject(
                          new CaxriError('TIMEOUT', `Caxri Server request timed out: ${method}`),
                      );
                  }, this.timeoutMs);
            this.pending.set(id, {
                parse: (value) => parseCaxriResult(method, value),
                resolve: (value) => {
                    completeTerminalLifecycle?.();
                    resolve(value);
                },
                reject: (error) => {
                    detachTransition?.cancel();
                    reject(error);
                },
                timer,
            });
            this.send({
                type: 'command',
                request: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id,
                    method: request.method,
                    params: request.params,
                },
            });
        });
    }

    requestServerOperation<M extends DesktopServerOperation>(
        method: M,
        ...arguments_: DesktopServerOperationArguments<M>
    ): Promise<DesktopServerOperationResult<M>> {
        if (this.closed)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Caxri Server connection is closed'),
            );
        if (!this.desktopLease)
            return Promise.reject(new CaxriError('FORBIDDEN', 'Desktop lease is required'));
        const [parameters, timeoutOverride] = arguments_;
        const request = parseServerOperationRequest(method, parameters);
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = isNonExpiringServerOperation(method)
                ? undefined
                : setTimeout(() => {
                      this.pending.delete(id);
                      reject(
                          new CaxriError('TIMEOUT', `Desktop Runtime request timed out: ${method}`),
                      );
                  }, timeoutOverride ?? this.timeoutMs);
            this.pending.set(id, {
                parse: (value) => parseServerOperationResult(method, value),
                resolve: (value) => resolve(value as DesktopServerOperationResult<M>),
                reject,
                timer,
            });
            this.send({
                type: 'desktop-runtime-command',
                request: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id,
                    method: request.method,
                    params: request.params,
                },
            });
        });
    }

    request<M extends CaxriMethod>(
        method: M,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodResult<M>>;
    request(method: CaxriMethod, parameters: unknown): Promise<unknown>;
    request(method: CaxriMethod, parameters?: unknown): Promise<unknown> {
        return this.sendRequest(randomUUID(), method, parameters);
    }

    /**
     * Preserves the caller's transport request ID across the Desktop-to-Server hop.
     */
    requestWithId<M extends CaxriMethod>(
        id: string,
        method: M,
        ...arguments_: ParametersArgument<M>
    ): Promise<MethodResult<M>>;
    requestWithId(id: string, method: CaxriMethod, parameters: unknown): Promise<unknown>;
    requestWithId(id: string, method: CaxriMethod, parameters?: unknown): Promise<unknown> {
        return this.sendRequest(id, method, parameters);
    }

    onEvent(listener: (event: LocalServerEvent['event']) => void): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    /**
     * Notifies once when this connection closes for any reason (socket loss, protocol failure, or an explicit
     * `close()`). An orderly Server lease takeover supplies `replaced`; other closures have no reason. `closeCode` is
     * the raw WebSocket close code when a close frame or local `terminate()` produced one, purely for diagnostics. A
     * listener registered after closure fires synchronously so callers cannot miss the transition.
     */
    onClose(
        listener: (reason?: DesktopLeaseRevocationReason, closeCode?: number) => void,
    ): () => void {
        if (this.closed) {
            listener(this.closeReason, this.closeCode);
            return () => {};
        }
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    /**
     * Forces an immediate Desktop lease renewal outside the normal `DESKTOP_LEASE_RENEW_MS` interval. Electron's
     * `powerMonitor` `resume`/`unlock-screen` events fire once Main's event loop is running again after a macOS sleep,
     * but the interval timer above only fires on its own next tick, which can land after Server Core's lease timer
     * (already woken from the same suspend) has fired first. Calling this from the `resume` handler closes that race
     * instead of waiting for the interval to catch up; it is a no-op without an active Desktop lease.
     */
    renewLeaseNow(): void {
        this.renewDesktopLease();
    }

    /**
     * Announces that Main has an attached Renderer event listener for one-shot window commands.
     */
    markDesktopReady(): Promise<void> {
        if (this.closed)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Caxri Server connection is closed'),
            );
        const lease = this.desktopLease;
        if (!lease) return Promise.reject(new CaxriError('FORBIDDEN', 'Desktop lease is required'));
        return new Promise((resolve, reject) => {
            this.send(
                localClientDesktopReadySchema.parse({
                    type: 'desktop.ready',
                    generation: lease.generation,
                }),
                (error) => {
                    if (error)
                        reject(
                            new CaxriError('UNAVAILABLE', 'Desktop readiness was not delivered'),
                        );
                    else resolve();
                },
            );
        });
    }

    close(options: { cancelPendingRequests?: boolean } = {}): void {
        this.failPending(
            options.cancelPendingRequests
                ? new CaxriError('CANCELLED', 'Caxri Server client was disposed')
                : new CaxriError('UNAVAILABLE', 'Caxri Server connection closed'),
        );
        this.socket.close(1000);
    }
}
