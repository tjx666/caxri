import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type {
    AgentEndpointRef as AgentEndpointReference,
    CommandDispatcher,
    CommandExecutionContext,
    CommandReplyEnvelope,
    DesktopLease,
    DesktopOperation,
    LocalClientCommand,
    ProtocolEventEnvelope,
    ServerControlEndpoint,
    TransientServerEvent,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    CONTROL_TRANSPORT_MAX_FRAME_BYTES,
    createCommandDispatcher,
    createProtocolWelcome,
    fromWireError,
    localClientCommandSchema,
    localClientDesktopOperationCommandSchema,
    localClientDesktopReadySchema,
    localClientDesktopReplySchema,
    localClientDesktopTargetConsumeSchema,
    localClientHelloSchema,
    localClientLeaseRenewSchema,
    localServerDesktopCommandSchema,
    localServerDesktopOperationReplySchema,
    localServerDesktopTargetReplySchema,
    localServerEventSchema,
    localServerLeaseRenewedSchema,
    localServerReplySchema,
    localServerWelcomeSchema,
    parseServerOperationRequest,
    toWireError,
} from '@caxri/protocol';
import type { WebSocketServer } from 'ws';
import WebSocket from 'ws';

import { BinaryStreamControl } from './binary-stream-control';
import { BinaryStreamRuntime } from './binary-stream-runtime';
import { listenForControlConnections } from './control-listener';
import type {
    ClientState,
    ControlServerOptions,
    DesktopLeaseWaiter,
    OrderedQueueTiming,
    PendingDesktopCommand,
} from './control-server-support';
import {
    assertDurableRecoveryIdentity,
    closeReplacedDesktop,
    controlCapacityReply,
    controlMessageText,
    DESKTOP_COMMAND_TIMEOUT_MS,
    DESKTOP_LEASE_MS,
    executeReply,
    HANDSHAKE_TIMEOUT_MS,
    isConcurrentRead,
    isTokenMatch,
    logControlRequestOutcome,
    operatorContext,
    reserveControlRequest,
    shouldSettleOutsideOrderedLane,
    trackControlRequest,
    untrackControlRequest,
} from './control-server-support';

export type { ControlServerOptions } from './control-server-support';

/**
 * Authenticated, profile-scoped WebSocket adapter for Desktop, Agent, and human CLI clients.
 */
export class ControlServer {
    private readonly binaryRuntime: BinaryStreamRuntime;
    private readonly binaryStreams: BinaryStreamControl;
    private readonly clients = new Map<WebSocket, ClientState>();
    private readonly sockets = new Set<WebSocket>();
    private readonly dispatch: CommandDispatcher;
    private readonly pendingDesktopCommands = new Map<string, PendingDesktopCommand>();
    private readonly desktopLeaseWaiters = new Set<DesktopLeaseWaiter>();
    private currentDesktop?: ClientState;
    private desktopGeneration = 0;
    private endpoint?: ServerControlEndpoint;
    private server?: Server;
    private webSocketServers: readonly WebSocketServer[] = [];

    constructor(private readonly options: ControlServerOptions) {
        assertDurableRecoveryIdentity(options);
        this.dispatch = createCommandDispatcher(options.adapters);
        this.binaryRuntime = new BinaryStreamRuntime({
            dispatch: this.dispatch,
            isDesktopConnectionCurrent: (connectionId) =>
                this.currentDesktop?.context.connection?.connectionId === connectionId,
            refreshContext: (context) => options.refreshContext?.(context) ?? context,
        });
        this.binaryStreams = new BinaryStreamControl({
            handleClaim:
                options.handleBinaryStream ??
                ((socket, claim) => this.binaryRuntime.accept(socket, claim)),
        });
    }

    private settleDesktopReply(state: ClientState, raw: unknown): boolean {
        const parsed = localClientDesktopReplySchema.safeParse(raw);
        if (!parsed.success) return false;
        const pending = parsed.data.reply.id
            ? this.pendingDesktopCommands.get(parsed.data.reply.id)
            : undefined;
        if (!pending) return true;
        if (
            pending.state !== state ||
            this.currentDesktop !== state ||
            parsed.data.generation !== state.desktopLease?.generation
        )
            return true;
        clearTimeout(pending.timer);
        this.pendingDesktopCommands.delete(parsed.data.reply.id!);
        if (parsed.data.reply.ok) pending.resolve(parsed.data.reply.result);
        else pending.reject(fromWireError(parsed.data.reply.error));
        return true;
    }

    private rejectDesktopCommands(state: ClientState): void {
        for (const [id, pending] of this.pendingDesktopCommands) {
            if (pending.state !== state) continue;
            clearTimeout(pending.timer);
            this.pendingDesktopCommands.delete(id);
            pending.reject(new CaxriError('UNAVAILABLE', 'Desktop capability lease ended'));
        }
    }

    private revokeDesktop(state: ClientState, shouldNotifyUnavailable = true): void {
        if (state.leaseTimer) clearTimeout(state.leaseTimer);
        state.leaseTimer = undefined;
        const connectionId = state.context.connection?.connectionId;
        if (connectionId) {
            this.binaryStreams.revokeConnection(connectionId, 'stale-generation');
            this.binaryRuntime.revokeConnection(connectionId, 'stale-generation');
        }
        this.rejectDesktopCommands(state);
        this.clients.delete(state.socket);
        const wasCurrent = this.currentDesktop === state;
        if (wasCurrent) this.currentDesktop = undefined;
        this.options.onClientCountChanged?.(this.clients.size);
        if (wasCurrent && shouldNotifyUnavailable) this.options.onDesktopUnavailable?.();
    }

    private renewDesktop(state: ClientState): DesktopLease {
        const lease = state.desktopLease;
        if (!lease || this.currentDesktop !== state)
            throw new CaxriError('CONFLICT', 'Desktop capability lease is stale');
        if (state.leaseTimer) clearTimeout(state.leaseTimer);
        const durationMs = this.options.desktopLeaseDurationMs ?? DESKTOP_LEASE_MS;
        const renewed = { ...lease, expiresAt: Date.now() + durationMs };
        state.desktopLease = renewed;
        state.leaseTimer = setTimeout(() => this.revokeDesktop(state), durationMs);
        state.leaseTimer.unref();
        return renewed;
    }

    private writeCommandReply(
        socket: WebSocket,
        state: ClientState,
        request: LocalClientCommand['request'],
        reply: CommandReplyEnvelope,
        context: CommandExecutionContext,
        release: () => void,
    ): void {
        if (this.options.shouldDropCommandReply?.(request, reply, context)) {
            release();
            untrackControlRequest(state, request.id);
            socket.terminate();
            return;
        }
        this.write(socket, localServerReplySchema.parse({ type: 'reply', reply }), () => {
            release();
            untrackControlRequest(state, request.id);
            this.options.onReplyFlushed?.(request, reply, context);
        });
    }

    private async dispatchCommand(
        socket: WebSocket,
        state: ClientState,
        request: LocalClientCommand['request'],
        timing?: OrderedQueueTiming,
        shouldSettleOutsideLane = false,
    ): Promise<void> {
        const startedAt = performance.now();
        const isTerminalHotPath =
            request.method === 'terminal.input' || request.method === 'terminal.resize';
        const release = reserveControlRequest(state, isTerminalHotPath);
        if (!release) {
            const reply = controlCapacityReply(request.id);
            logControlRequestOutcome(
                this.options,
                request,
                reply,
                state.context,
                startedAt,
                timing,
            );
            this.write(socket, localServerReplySchema.parse({ type: 'reply', reply }));
            return;
        }
        trackControlRequest(state, request.id);
        let context: CommandExecutionContext;
        try {
            const refreshed = this.options.refreshContext?.(state.context) ?? state.context;
            context = { ...refreshed, connection: state.context.connection };
        } catch (error) {
            const reply: CommandReplyEnvelope = {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: request.id,
                ok: false,
                error: toWireError(error),
            };
            logControlRequestOutcome(
                this.options,
                request,
                reply,
                state.context,
                startedAt,
                timing,
            );
            this.writeCommandReply(socket, state, request, reply, state.context, release);
            return;
        }
        const admission =
            context.principal.kind === 'desktop' && this.currentDesktop !== state
                ? {
                      reply: Promise.resolve({
                          protocolVersion: CAXRI_PROTOCOL_VERSION,
                          id: request.id,
                          ok: false as const,
                          error: toWireError(
                              new CaxriError('CONFLICT', 'Desktop capability lease is stale'),
                          ),
                      }),
                  }
                : await this.dispatch.admit(request, context);
        const settle = async (): Promise<void> => {
            try {
                const reply = await admission.reply;
                logControlRequestOutcome(this.options, request, reply, context, startedAt, timing);
                this.writeCommandReply(socket, state, request, reply, context, release);
            } catch {
                socket.terminate();
            }
        };
        if (shouldSettleOutsideLane) {
            // Admission is already ordered; this completion owns its own failure handling.
            // eslint-disable-next-line no-void -- authoritative reply settles independently
            void settle();
        } else await settle();
    }

    private async dispatchDesktopOperation(
        socket: WebSocket,
        state: ClientState,
        request: { id: string; method: string; params: unknown },
        timing?: OrderedQueueTiming,
    ): Promise<void> {
        const startedAt = performance.now();
        const release = reserveControlRequest(state);
        const reply = release
            ? await executeReply(request.id, async () => {
                  if (state.context.principal.kind !== 'desktop' || this.currentDesktop !== state)
                      throw new CaxriError('CONFLICT', 'Desktop capability lease is stale');
                  if (!this.options.invokeDesktopOperation)
                      throw new CaxriError('UNAVAILABLE', 'Desktop Runtime bridge is unavailable');
                  return this.options.invokeDesktopOperation(
                      parseServerOperationRequest(request.method, request.params),
                  );
              })
            : controlCapacityReply(request.id);
        logControlRequestOutcome(this.options, request, reply, state.context, startedAt, timing);
        this.write(
            socket,
            localServerDesktopOperationReplySchema.parse({
                type: 'desktop-runtime-reply',
                reply,
            }),
            release,
        );
    }

    private async dispatchDesktopTargetConsume(
        socket: WebSocket,
        state: ClientState,
        request: { generation: number; id: string; targetId: string },
    ): Promise<void> {
        const release = reserveControlRequest(state);
        const reply = release
            ? await executeReply(request.id, async () => {
                  if (
                      state.context.principal.kind !== 'desktop' ||
                      this.currentDesktop !== state ||
                      state.desktopLease?.generation !== request.generation
                  )
                      throw new CaxriError('CONFLICT', 'Desktop capability lease is stale');
                  if (!this.options.consumeDesktopTarget)
                      throw new CaxriError('UNAVAILABLE', 'Desktop target bridge is unavailable');
                  return this.options.consumeDesktopTarget(request.targetId, request.generation);
              })
            : controlCapacityReply(request.id);
        this.write(
            socket,
            localServerDesktopTargetReplySchema.parse({
                type: 'desktop-target.reply',
                reply,
            }),
            release,
        );
    }

    private accept(socket: WebSocket): void {
        this.sockets.add(socket);
        const handshakeTimer = setTimeout(() => socket.terminate(), HANDSHAKE_TIMEOUT_MS);
        let state: ClientState | undefined;
        let queue = Promise.resolve();
        let orderedBacklog = 0;

        const remove = (): void => {
            clearTimeout(handshakeTimer);
            this.sockets.delete(socket);
            if (!state) return;
            const connectionId = state.context.connection?.connectionId;
            if (connectionId) {
                this.binaryStreams.revokeConnection(connectionId, 'server-unavailable');
                this.binaryRuntime.revokeConnection(connectionId, 'server-unavailable');
            }
            for (const requestId of state.inFlightRequestIds.keys())
                this.options.onRequestDisconnected?.(requestId, state.context);
            state.inFlightRequestIds.clear();
            state.closed = true;
            state.inFlightRequests = 0;
            state.inFlightTerminalRequests = 0;
            if (!this.clients.has(socket)) return;
            if (state.desktopLease) this.revokeDesktop(state);
            else {
                this.clients.delete(socket);
                this.options.onClientCountChanged?.(this.clients.size);
            }
        };
        socket.on('close', remove);
        socket.on('error', () => {});
        socket.on('message', (data, isBinary) => {
            if (isBinary) {
                socket.terminate();
                return;
            }
            let raw: unknown;
            try {
                raw = JSON.parse(controlMessageText(data)) as unknown;
            } catch {
                socket.terminate();
                return;
            }
            /**
             * Reverse replies must settle outside the ordered protocol-control queue to avoid a Desktop request
             * deadlocking while Server Core routes a nested window operation back.
             */
            if (state && this.settleDesktopReply(state, raw)) return;
            const nestedTarget = state
                ? localClientDesktopTargetConsumeSchema.safeParse(raw)
                : undefined;
            /**
             * A Server-issued Desktop command redeems its opaque target before it can reply. The redemption must bypass
             * the command that is awaiting that reply or both sides deadlock; generation checks and the one-use target
             * still bound this lane.
             */
            if (state?.context.principal.kind === 'desktop' && nestedTarget?.success) {
                // This branch intentionally bypasses `queue` to avoid the nested-command
                // deadlock described above, and the enclosing 'data' handler is synchronous,
                // so the dispatch here must be fire-and-forget rather than awaited.
                // eslint-disable-next-line unicorn/prefer-await -- see comment above
                this.dispatchDesktopTargetConsume(socket, state, nestedTarget.data).catch(() =>
                    socket.terminate(),
                );
                return;
            }
            const renew = state ? localClientLeaseRenewSchema.safeParse(raw) : undefined;
            /**
             * Lease renewal is authenticated control traffic, so it must not wait behind a long ordered file operation
             * and accidentally revoke the active Desktop.
             */
            if (state?.context.principal.kind === 'desktop' && renew?.success) {
                try {
                    if (state.desktopLease?.generation !== renew.data.generation)
                        throw new CaxriError('CONFLICT', 'Desktop capability lease is stale');
                    this.write(
                        socket,
                        localServerLeaseRenewedSchema.parse({
                            type: 'desktop-lease.renewed',
                            lease: this.renewDesktop(state),
                        }),
                    );
                } catch {
                    socket.terminate();
                }
                return;
            }
            const streamTicket = state ? this.binaryStreams.issue(state, raw) : undefined;
            if (streamTicket) {
                this.write(socket, streamTicket);
                return;
            }
            /**
             * Only authenticated Desktop PTY input can bypass a slow ordinary command. The handshake remains on
             * `queue`, and this path keeps its own bounded reservation in `dispatchCommand`.
             */
            const hotCommand = state ? localClientCommandSchema.safeParse(raw) : undefined;
            const hotRequest = hotCommand?.success ? hotCommand.data.request : undefined;
            if (
                hotRequest &&
                (hotRequest.method === 'terminal.input' ||
                    hotRequest.method === 'terminal.resize') &&
                state?.context.principal.kind === 'desktop'
            ) {
                // This hot path intentionally bypasses `queue` for interactive Terminal
                // traffic, and the enclosing 'data' handler is synchronous, so the dispatch
                // here must be fire-and-forget rather than awaited.
                // eslint-disable-next-line unicorn/prefer-await -- see comment above
                this.dispatchCommand(socket, state, hotRequest).catch(() => socket.terminate());
                return;
            }
            /**
             * Cancellation is authenticated control traffic. It must reach the Core adapter immediately even when an
             * earlier request is still waiting on domain or Extension Host work.
             */
            if (
                state &&
                (hotRequest?.method === 'viewContainers.cancelRequest' ||
                    hotRequest?.method === 'requests.cancel')
            ) {
                // This path intentionally bypasses `queue`; the data callback is synchronous, so dispatch is
                // fire-and-forget and owns its own reply/error handling.
                const cancellation = this.dispatchCommand(
                    socket,
                    state,
                    hotRequest,
                    undefined,
                    true,
                );
                // eslint-disable-next-line unicorn/prefer-await -- the synchronous data callback cannot await
                cancellation.catch(() => socket.terminate());
                return;
            }
            // `queue` preserves handshake, control, and mutation order across repeated invocations of this
            // synchronous 'data' handler. Reads begin in arrival order but settle independently, so a slow status
            // or long-poll request cannot block later work. Promise chaining is required because `await` cannot
            // span callbacks.
            const enqueuedAt = performance.now();
            orderedBacklog += 1;
            const timing: OrderedQueueTiming = { enqueuedAt, queueDepth: orderedBacklog };
            queue = queue
                // eslint-disable-next-line unicorn/prefer-await -- see queue-chaining note above
                .then(async () => {
                    if (!state) {
                        const hello = localClientHelloSchema.parse(raw);
                        const identity = this.options.identity;
                        if (hello.profileId !== identity.profileId) {
                            socket.terminate();
                            return;
                        }
                        let context: CommandExecutionContext;
                        let desktopLease: DesktopLease | undefined;
                        if (hello.credential.kind === 'operator') {
                            if (!isTokenMatch(hello.credential.token, identity.operatorToken)) {
                                socket.terminate();
                                return;
                            }
                            context = operatorContext(identity.profileId);
                        } else if (hello.credential.kind === 'agent') {
                            if (!this.options.authenticateAgent) {
                                socket.terminate();
                                return;
                            }
                            try {
                                context = this.options.authenticateAgent(hello.credential);
                            } catch {
                                socket.terminate();
                                return;
                            }
                        } else {
                            const credential = this.options.desktopCredential;
                            if (
                                credential.profileId !== identity.profileId ||
                                credential.processIdentity !== identity.processIdentity ||
                                !isTokenMatch(hello.credential.token, credential.desktopToken)
                            ) {
                                socket.terminate();
                                return;
                            }
                            const generation = ++this.desktopGeneration;
                            desktopLease = {
                                desktopId: hello.credential.desktopId,
                                generation,
                                expiresAt:
                                    Date.now() +
                                    (this.options.desktopLeaseDurationMs ?? DESKTOP_LEASE_MS),
                            };
                            context = {
                                capabilities: ['desktop'],
                                principal: {
                                    kind: 'desktop',
                                    id: hello.credential.desktopId,
                                    generation,
                                },
                            };
                            if (this.currentDesktop) {
                                const replaced = this.currentDesktop;
                                this.revokeDesktop(replaced, false);
                                closeReplacedDesktop(replaced);
                            }
                        }
                        const protocolIdentity = this.options.protocolIdentity ?? {
                            serverId: identity.processIdentity,
                            stateEpoch: identity.processIdentity,
                        };
                        const connection = {
                            serverId: protocolIdentity.serverId,
                            bootId: identity.processIdentity,
                            stateEpoch: protocolIdentity.stateEpoch,
                            clientId: hello.clientId,
                            connectionId: randomUUID().replaceAll('-', ''),
                        };
                        context = { ...context, connection };
                        const welcome = createProtocolWelcome(
                            this.options.adapters,
                            hello,
                            context,
                        );
                        const nextState: ClientState = {
                            closed: false,
                            commands: welcome.commands,
                            context,
                            desktopLease,
                            desktopReady: false,
                            inFlightRequestIds: new Map(),
                            inFlightRequests: 0,
                            inFlightTerminalRequests: 0,
                            features: welcome.features ?? [],
                            socket,
                        };
                        state = nextState;
                        clearTimeout(handshakeTimer);
                        this.clients.set(socket, nextState);
                        if (desktopLease) {
                            this.currentDesktop = nextState;
                            this.renewDesktop(nextState);
                        }
                        this.options.onClientCountChanged?.(this.clients.size);
                        this.write(
                            socket,
                            localServerWelcomeSchema.parse({
                                type: 'welcome',
                                profileId: identity.profileId,
                                processIdentity: identity.processIdentity,
                                ...(desktopLease && { desktopLease: nextState.desktopLease }),
                                ...welcome,
                            }),
                        );
                        return;
                    }
                    const clientState = state;
                    const ready = localClientDesktopReadySchema.safeParse(raw);
                    if (ready.success) {
                        const principal = clientState.context.principal;
                        const desktopLease = clientState.desktopLease;
                        if (
                            !desktopLease ||
                            principal.kind !== 'desktop' ||
                            this.currentDesktop !== clientState ||
                            desktopLease.generation !== ready.data.generation
                        )
                            throw new CaxriError('CONFLICT', 'Desktop capability lease is stale');
                        clientState.desktopReady = true;
                        for (const waiter of this.desktopLeaseWaiters) {
                            clearTimeout(waiter.timer);
                            waiter.resolve(desktopLease);
                        }
                        this.desktopLeaseWaiters.clear();
                        return;
                    }
                    const operationCommand =
                        localClientDesktopOperationCommandSchema.safeParse(raw);
                    if (operationCommand.success) {
                        const dispatch = this.dispatchDesktopOperation(
                            socket,
                            clientState,
                            operationCommand.data.request,
                            timing,
                        );
                        if (isConcurrentRead(operationCommand.data.request.method)) {
                            // eslint-disable-next-line promise/no-nesting, unicorn/prefer-await -- reads settle outside the ordered lane
                            dispatch.catch(() => socket.terminate());
                        } else await dispatch;
                        return;
                    }
                    const consume = localClientDesktopTargetConsumeSchema.safeParse(raw);
                    if (consume.success) {
                        await this.dispatchDesktopTargetConsume(socket, clientState, consume.data);
                        return;
                    }
                    const command = localClientCommandSchema.parse(raw);
                    const dispatch = this.dispatchCommand(
                        socket,
                        clientState,
                        command.request,
                        timing,
                        shouldSettleOutsideOrderedLane(command.request.method),
                    );
                    if (isConcurrentRead(command.request.method)) {
                        // eslint-disable-next-line promise/no-nesting, unicorn/prefer-await -- reads settle outside the ordered lane
                        dispatch.catch(() => socket.terminate());
                    } else await dispatch;
                })
                // eslint-disable-next-line unicorn/prefer-await -- see queue-chaining note above
                .catch(() => {
                    socket.terminate();
                })
                // eslint-disable-next-line unicorn/prefer-await -- see queue-chaining note above
                .finally(() => {
                    // Concurrent reads continue independently after their ordered admission entry.
                    orderedBacklog -= 1;
                });
        });
    }

    private write(socket: WebSocket, message: unknown, flushed?: () => void): void {
        const source = JSON.stringify(message);
        if (
            socket.readyState !== WebSocket.OPEN ||
            socket.bufferedAmount + Buffer.byteLength(source, 'utf8') >
                CONTROL_TRANSPORT_MAX_FRAME_BYTES
        ) {
            socket.terminate();
            return;
        }
        socket.send(source, (error) => {
            if (error) socket.terminate();
            else flushed?.();
        });
    }

    clientCount(): number {
        return this.clients.size;
    }

    desktopLease(): DesktopLease | undefined {
        return this.currentDesktop?.desktopReady ? this.currentDesktop.desktopLease : undefined;
    }

    waitForDesktopLease(timeoutMs: number): Promise<DesktopLease> {
        const lease = this.desktopLease();
        if (lease) return Promise.resolve(lease);
        if (this.desktopLeaseWaiters.size >= 32)
            return Promise.reject(
                new CaxriError('CAPACITY', 'Too many Desktop launches are pending'),
            );
        return new Promise((resolve, reject) => {
            const waiter: DesktopLeaseWaiter = {
                reject,
                resolve,
                timer: setTimeout(() => {
                    this.desktopLeaseWaiters.delete(waiter);
                    reject(
                        new CaxriError('TIMEOUT', 'Desktop did not connect before the deadline'),
                    );
                }, timeoutMs),
            };
            this.desktopLeaseWaiters.add(waiter);
        });
    }

    /**
     * Routes one typed window operation to exactly the current Desktop generation.
     */
    invokeDesktop(operation: DesktopOperation, expectedGeneration: number): Promise<unknown> {
        const state = this.currentDesktop;
        const lease = state?.desktopLease;
        if (!state || !lease || !state.desktopReady)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Desktop is unavailable'));
        if (lease.generation !== expectedGeneration)
            return Promise.reject(
                new CaxriError('CONFLICT', 'Desktop capability lease changed before routing'),
            );
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingDesktopCommands.delete(id);
                reject(new CaxriError('TIMEOUT', 'Desktop command timed out'));
            }, DESKTOP_COMMAND_TIMEOUT_MS);
            this.pendingDesktopCommands.set(id, { reject, resolve, state, timer });
            this.write(
                state.socket,
                localServerDesktopCommandSchema.parse({
                    type: 'desktop-command',
                    lease,
                    request: {
                        protocolVersion: CAXRI_PROTOCOL_VERSION,
                        id,
                        operation,
                    },
                }),
            );
        });
    }

    async start(): Promise<ServerControlEndpoint> {
        if (this.server && this.endpoint) return this.endpoint;
        const listener = await listenForControlConnections({
            identity: this.options.identity,
            onConnection: (connection) => this.accept(connection),
            onStreamConnection: (connection, request) =>
                this.binaryStreams.accept(connection, request),
        });
        this.server = listener.server;
        this.webSocketServers = listener.webSocketServers;
        this.endpoint = listener.endpoint;
        return listener.endpoint;
    }

    broadcast(event: ProtocolEventEnvelope | TransientServerEvent): void {
        if (this.binaryRuntime.deliver(event)) return;
        const message = localServerEventSchema.parse({ type: 'event', event });
        /**
         * Raw domain payloads are a Desktop-only transport; other principals use projections.
         */
        if (this.currentDesktop?.desktopReady) this.write(this.currentDesktop.socket, message);
    }

    /**
     * Delivers a transient, body-free receipt only to the exact authenticated Agent generation.
     */
    broadcastAgent(endpoint: AgentEndpointReference, event: TransientServerEvent): void {
        const message = localServerEventSchema.parse({ type: 'event', event });
        for (const state of this.clients.values()) {
            const principal = state.context.principal;
            if (
                principal.kind === 'agent' &&
                principal.endpointId === endpoint.endpointId &&
                principal.generation === endpoint.generation
            )
                this.write(state.socket, message);
        }
    }

    /**
     * Delivers a one-shot Server UI event without placing it in the recoverable event journal.
     */
    broadcastDesktop(event: TransientServerEvent): void {
        const message = localServerEventSchema.parse({ type: 'event', event });
        if (this.currentDesktop?.desktopReady) this.write(this.currentDesktop.socket, message);
    }

    async close(): Promise<void> {
        for (const pending of this.pendingDesktopCommands.values()) {
            clearTimeout(pending.timer);
            pending.reject(new CaxriError('UNAVAILABLE', 'Host transport is closing'));
        }
        this.pendingDesktopCommands.clear();
        for (const waiter of this.desktopLeaseWaiters) {
            clearTimeout(waiter.timer);
            waiter.reject(new CaxriError('UNAVAILABLE', 'Host transport is closing'));
        }
        this.desktopLeaseWaiters.clear();
        this.binaryRuntime.close();
        this.binaryStreams.close();
        for (const socket of this.sockets) socket.terminate();
        this.sockets.clear();
        this.clients.clear();
        if (this.currentDesktop?.leaseTimer) clearTimeout(this.currentDesktop.leaseTimer);
        this.currentDesktop = undefined;
        this.options.onClientCountChanged?.(0);
        const server = this.server;
        this.server = undefined;
        if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const webSocketServer of this.webSocketServers) webSocketServer.close();
        this.webSocketServers = [];
        this.endpoint = undefined;
    }
}
