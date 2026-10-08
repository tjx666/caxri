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
    createCommandDispatcher,
    createProtocolWelcome,
    isBinaryStreamMethod,
    isConcurrentRead,
    localClientCommandSchema,
    localClientDesktopOperationCommandSchema,
    localClientDesktopReadySchema,
    localClientDesktopTargetConsumeSchema,
    localClientHelloSchema,
    localClientLeaseRenewSchema,
    localServerDesktopOperationReplySchema,
    localServerDesktopTargetReplySchema,
    localServerLeaseRenewedSchema,
    localServerReplySchema,
    localServerWelcomeSchema,
    parseServerOperationRequest,
    toWireError,
} from '@caxri/protocol';
import type WebSocket from 'ws';
import type { WebSocketServer } from 'ws';

import { BinaryStreamControl } from './binary-stream-control';
import { BinaryStreamRuntime } from './binary-stream-runtime';
import { listenForControlConnections } from './control-listener';
import type { DesktopLeaseHost, PendingDesktopCommand } from './control-server-desktop-lease';
import {
    clearLeaseLivenessProbe,
    closeReplacedDesktop,
    DESKTOP_LEASE_MS,
    didHandleDesktopReply,
    renewDesktop,
    revokeDesktop,
    routeDesktopOperation,
} from './control-server-desktop-lease';
import type {
    ClientState,
    ControlServerOptions,
    ControlSocketTerminationReason,
    DesktopLeaseWaiter,
    OrderedQueueTiming,
} from './control-server-support';
import {
    assertDurableRecoveryIdentity,
    controlCapacityReply,
    controlMessageText,
    executeReply,
    HANDSHAKE_TIMEOUT_MS,
    isTokenMatch,
    logControlRequestOutcome,
    observeControlRequest,
    operatorContext,
    refreshDelegationReply,
    reserveControlRequest,
    shouldSettleOutsideOrderedLane,
    terminateSocket,
    trackControlRequest,
    untrackControlRequest,
    writeAgentControlEvent,
    writeControlMessage,
    writeDesktopControlEvent,
} from './control-server-support';
import type { TerminalDetachTransition } from './terminal-stream-lifecycle';

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
            logger: options.logger,
            refreshContext: (context) => options.refreshContext?.(context) ?? context,
        });
        this.binaryStreams = new BinaryStreamControl({
            handleClaim:
                options.handleBinaryStream ??
                ((socket, claim) => this.binaryRuntime.accept(socket, claim)),
            terminalGeneration: (operation) => this.binaryRuntime.terminalGeneration(operation),
        });
    }

    /**
     * Desktop lease arming/revocation lives in `control-server-desktop-lease.ts` as plain `DesktopLeaseHost` functions
     * (see `DESKTOP_LEASE_GRACE_MS` there). The cast below is safe: `this` structurally satisfies `DesktopLeaseHost` at
     * runtime; TypeScript only rejects a plain assignment because the members it needs are `private` here, and a
     * private member can satisfy assignability only against another private member of the exact same class.
     */
    private get leaseHost(): DesktopLeaseHost {
        return this as unknown as DesktopLeaseHost;
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
            terminateSocket(socket, 'reply-drop-injected', this.options.logger, context);
            return;
        }
        writeControlMessage(
            socket,
            localServerReplySchema.parse({ type: 'reply', reply }),
            () => {
                release();
                untrackControlRequest(state, request.id);
                this.options.onReplyFlushed?.(request, reply, context);
            },
            this.options.logger,
            context,
        );
    }

    private async dispatchCommand(
        socket: WebSocket,
        state: ClientState,
        request: LocalClientCommand['request'],
        timing?: OrderedQueueTiming,
        shouldSettleOutsideLane = false,
        terminalDetach?: TerminalDetachTransition,
    ): Promise<void> {
        if (terminalDetach) {
            await terminalDetach.waitForPriorOperations();
            try {
                await this.dispatchCommand(socket, state, request, timing, shouldSettleOutsideLane);
            } finally {
                terminalDetach.complete();
            }
            return;
        }
        const startedAt = performance.now();
        if (isBinaryStreamMethod(request.method)) {
            const reply: CommandReplyEnvelope = {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: request.id,
                ok: false,
                error: toWireError(
                    new CaxriError('VALIDATION', 'Bulk method requires an authenticated stream'),
                ),
            };
            logControlRequestOutcome(
                this.options,
                request,
                reply,
                state.context,
                startedAt,
                timing,
            );
            writeControlMessage(
                socket,
                localServerReplySchema.parse({ type: 'reply', reply }),
                undefined,
                this.options.logger,
                state.context,
            );
            return;
        }
        const release = reserveControlRequest(state);
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
            writeControlMessage(
                socket,
                localServerReplySchema.parse({ type: 'reply', reply }),
                undefined,
                this.options.logger,
                state.context,
            );
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
                const reply = refreshDelegationReply(await admission.reply, context, this.options);
                logControlRequestOutcome(this.options, request, reply, context, startedAt, timing);
                this.writeCommandReply(socket, state, request, reply, context, release);
            } catch {
                terminateSocket(socket, 'reply-settle-failed', this.options.logger, context);
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
        writeControlMessage(
            socket,
            localServerDesktopOperationReplySchema.parse({
                type: 'desktop-runtime-reply',
                reply,
            }),
            release,
            this.options.logger,
            state.context,
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
        writeControlMessage(
            socket,
            localServerDesktopTargetReplySchema.parse({
                type: 'desktop-target.reply',
                reply,
            }),
            release,
            this.options.logger,
            state.context,
        );
    }

    private accept(socket: WebSocket): void {
        this.sockets.add(socket);
        /**
         * Local shorthand: every termination in this handler shares the same socket and logger, so binding them once
         * here keeps each call site to the part that actually varies.
         */
        const terminate = (
            reason: ControlSocketTerminationReason,
            context?: CommandExecutionContext,
        ): void => terminateSocket(socket, reason, this.options.logger, context);
        const handshakeTimer = setTimeout(
            () => terminate('handshake-timeout'),
            HANDSHAKE_TIMEOUT_MS,
        );
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
            if (!this.clients.has(socket)) return;
            if (state.desktopLease) revokeDesktop(this.leaseHost, state, true, 'connection-closed');
            else {
                this.clients.delete(socket);
                this.options.onClientCountChanged?.(this.clients.size, 'disconnected');
            }
        };
        socket.on('close', remove);
        socket.on('error', () => {});
        socket.on('message', (data, isBinary) => {
            if (isBinary) {
                terminate('binary-frame-received', state?.context);
                return;
            }
            let raw: unknown;
            try {
                raw = JSON.parse(controlMessageText(data)) as unknown;
            } catch {
                terminate('invalid-message', state?.context);
                return;
            }
            /**
             * Reverse replies must settle outside the ordered protocol-control queue to avoid a Desktop request
             * deadlocking while Server Core routes a nested window operation back.
             */
            if (state && didHandleDesktopReply(this.leaseHost, state, raw)) return;
            const nestedTarget = state
                ? localClientDesktopTargetConsumeSchema.safeParse(raw)
                : undefined;
            /**
             * A Server-issued Desktop command redeems its opaque target before it can reply. The redemption must bypass
             * the command that is awaiting that reply or both sides deadlock; generation checks and the one-use target
             * still bound this lane.
             */
            if (state?.context.principal.kind === 'desktop' && nestedTarget?.success) {
                const desktopState = state;
                // This branch intentionally bypasses `queue` to avoid the nested-command
                // deadlock described above, and the enclosing 'data' handler is synchronous,
                // so the dispatch here must be fire-and-forget rather than awaited.
                // eslint-disable-next-line unicorn/prefer-await -- see comment above
                this.dispatchDesktopTargetConsume(socket, desktopState, nestedTarget.data).catch(
                    () => terminate('desktop-target-consume-failed', desktopState.context),
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
                    writeControlMessage(
                        socket,
                        localServerLeaseRenewedSchema.parse({
                            type: 'desktop-lease.renewed',
                            lease: renewDesktop(this.leaseHost, state),
                        }),
                        undefined,
                        this.options.logger,
                        state.context,
                    );
                } catch {
                    terminate('lease-renew-stale-generation', state.context);
                }
                return;
            }
            const streamTicket = state ? this.binaryStreams.issue(state, raw) : undefined;
            if (streamTicket) {
                writeControlMessage(
                    socket,
                    streamTicket,
                    undefined,
                    this.options.logger,
                    state?.context,
                );
                return;
            }
            const immediateCommand = state ? localClientCommandSchema.safeParse(raw) : undefined;
            const immediateRequest = immediateCommand?.success
                ? immediateCommand.data.request
                : undefined;
            const terminalDetach =
                state &&
                immediateRequest?.method === 'terminal.detach' &&
                state.commands.includes(immediateRequest.method)
                    ? this.binaryRuntime.beginTerminalDetachRequest(immediateRequest.params)
                    : undefined;
            /**
             * Cancellation is authenticated control traffic. It must reach the Core adapter immediately even when an
             * earlier request is still waiting on domain or Extension Host work.
             */
            if (
                state &&
                (immediateRequest?.method === 'viewContainers.cancelRequest' ||
                    immediateRequest?.method === 'requests.cancel')
            ) {
                // This path intentionally bypasses `queue`; the data callback is synchronous, so dispatch is
                // fire-and-forget and owns its own reply/error handling.
                const clientState = state;
                const cancellation = observeControlRequest(clientState, immediateRequest, () =>
                    this.dispatchCommand(socket, clientState, immediateRequest, undefined, true),
                );
                // eslint-disable-next-line unicorn/prefer-await -- the synchronous data callback cannot await
                cancellation.catch(() =>
                    terminate('cancellation-dispatch-failed', clientState.context),
                );
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
                            terminate('hello-profile-mismatch');
                            return;
                        }
                        let context: CommandExecutionContext;
                        let desktopLease: DesktopLease | undefined;
                        switch (hello.credential.kind) {
                            case 'operator': {
                                if (!isTokenMatch(hello.credential.token, identity.operatorToken)) {
                                    terminate('hello-operator-token-mismatch');
                                    return;
                                }
                                context = operatorContext(identity.profileId);

                                break;
                            }
                            case 'delegation-client':
                            case 'agent': {
                                try {
                                    const authenticated =
                                        hello.credential.kind === 'agent'
                                            ? this.options.authenticateAgent?.(hello.credential)
                                            : this.options.authenticateDelegation?.(
                                                  hello.credential,
                                              );
                                    if (!authenticated) {
                                        terminate('hello-agent-auth-unavailable');
                                        return;
                                    }
                                    context = authenticated;
                                } catch {
                                    terminate('hello-agent-auth-failed');
                                    return;
                                }

                                break;
                            }
                            default: {
                                const credential = this.options.desktopCredential;
                                if (
                                    credential.profileId !== identity.profileId ||
                                    credential.processIdentity !== identity.processIdentity ||
                                    !isTokenMatch(hello.credential.token, credential.desktopToken)
                                ) {
                                    terminate('hello-desktop-credential-mismatch');
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
                                    revokeDesktop(this.leaseHost, replaced, false, 'replaced');
                                    closeReplacedDesktop(replaced, this.options.logger);
                                }
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
                            features: welcome.features ?? [],
                            socket,
                        };
                        state = nextState;
                        clearTimeout(handshakeTimer);
                        this.clients.set(socket, nextState);
                        if (desktopLease) {
                            this.currentDesktop = nextState;
                            renewDesktop(this.leaseHost, nextState);
                        }
                        this.options.onClientCountChanged?.(this.clients.size, 'connected');
                        writeControlMessage(
                            socket,
                            localServerWelcomeSchema.parse({
                                type: 'welcome',
                                profileId: identity.profileId,
                                processIdentity: identity.processIdentity,
                                ...(desktopLease && { desktopLease: nextState.desktopLease }),
                                ...welcome,
                            }),
                            undefined,
                            this.options.logger,
                            context,
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
                        const dispatch = observeControlRequest(
                            clientState,
                            operationCommand.data.request,
                            () =>
                                this.dispatchDesktopOperation(
                                    socket,
                                    clientState,
                                    operationCommand.data.request,
                                    timing,
                                ),
                        );
                        if (isConcurrentRead(operationCommand.data.request.method)) {
                            // eslint-disable-next-line unicorn/prefer-await -- reads settle outside the ordered lane
                            dispatch.catch(() =>
                                terminate('desktop-operation-dispatch-failed', clientState.context),
                            );
                        } else await dispatch;
                        return;
                    }
                    const consume = localClientDesktopTargetConsumeSchema.safeParse(raw);
                    if (consume.success) {
                        await this.dispatchDesktopTargetConsume(socket, clientState, consume.data);
                        return;
                    }
                    const command = localClientCommandSchema.parse(raw);
                    const dispatch = observeControlRequest(clientState, command.request, () =>
                        this.dispatchCommand(
                            socket,
                            clientState,
                            command.request,
                            timing,
                            shouldSettleOutsideOrderedLane(command.request.method),
                            terminalDetach,
                        ),
                    );
                    if (isConcurrentRead(command.request.method)) {
                        // eslint-disable-next-line unicorn/prefer-await -- reads settle outside the ordered lane
                        dispatch.catch(() =>
                            terminate('command-dispatch-failed', clientState.context),
                        );
                    } else await dispatch;
                })
                // eslint-disable-next-line unicorn/prefer-await -- see queue-chaining note above
                .catch(() => {
                    terminate('queue-processing-failed', state?.context);
                })
                // eslint-disable-next-line unicorn/prefer-await -- see queue-chaining note above
                .finally(() => {
                    // Concurrent reads continue independently after their ordered admission entry.
                    orderedBacklog -= 1;
                });
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
     * Routes one typed window operation to exactly the current Desktop generation. Implementation lives in
     * `routeDesktopOperation` in `control-server-desktop-lease.ts`, alongside the rest of the `DesktopLeaseHost`
     * group.
     */
    invokeDesktop(operation: DesktopOperation, expectedGeneration: number): Promise<unknown> {
        return routeDesktopOperation(this.leaseHost, operation, expectedGeneration);
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
        const projected = typeof event.event === 'string' ? event : event.event;
        if (this.binaryRuntime.deliver(event) || projected.event === 'terminal.output') return;
        writeDesktopControlEvent(this.currentDesktop, event, this.options.logger);
    }

    /**
     * Delivers a transient, body-free receipt only to the exact authenticated Agent generation.
     */
    broadcastAgent(endpoint: AgentEndpointReference, event: TransientServerEvent): void {
        writeAgentControlEvent(this.clients.values(), endpoint, event, this.options.logger);
    }

    /**
     * Delivers a one-shot Server UI event without placing it in the recoverable event journal.
     */
    broadcastDesktop(event: TransientServerEvent): void {
        writeDesktopControlEvent(this.currentDesktop, event, this.options.logger);
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
        for (const socket of this.sockets)
            terminateSocket(
                socket,
                'server-closing',
                this.options.logger,
                this.clients.get(socket)?.context,
            );
        this.sockets.clear();
        this.clients.clear();
        if (this.currentDesktop) clearLeaseLivenessProbe(this.currentDesktop);
        if (this.currentDesktop?.leaseTimer) clearTimeout(this.currentDesktop.leaseTimer);
        this.currentDesktop = undefined;
        this.options.onClientCountChanged?.(0, 'reset');
        const server = this.server;
        this.server = undefined;
        if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const webSocketServer of this.webSocketServers) webSocketServer.close();
        this.webSocketServers = [];
        this.endpoint = undefined;
    }
}
