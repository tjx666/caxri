import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';

import {
    createCommandDispatcher,
    createProtocolWelcome,
    type CommandDispatcher,
    type CommandDispatcherOptions,
} from '../shared/ipc/dispatcher';
import { CaxriError, fromWireError, toWireError } from '../shared/ipc/errors';
import type { ProtocolEventEnvelope, TransientRuntimeEvent } from '../shared/ipc/event-journal';
import {
    localClientCommandSchema,
    localClientDesktopReplySchema,
    localClientDesktopReadySchema,
    localClientDesktopRuntimeCommandSchema,
    localClientDesktopTargetConsumeSchema,
    localClientHelloSchema,
    localClientLeaseRenewSchema,
    localServerDesktopCommandSchema,
    localServerDesktopRuntimeReplySchema,
    localServerDesktopTargetReplySchema,
    localServerEventSchema,
    localServerLeaseRenewedSchema,
    localServerReplySchema,
    localServerWelcomeSchema,
    type DesktopLease,
    type DesktopOperation,
    type DesktopTargetPayload,
    type HostDesktopCredential,
    type LocalClientCommand,
    type LocalServerReply,
    type HostManifest,
} from '../shared/ipc/local-transport';
import type { CommandExecutionContext } from '../shared/ipc/principal';
import type { AgentEndpointRef } from '../shared/ipc/agent-endpoint-contract';
import { parseRuntimeRequest, type CommandReplyEnvelope } from '../shared/ipc/transport';
import type { RuntimeRequest } from '../shared/ipc/methods';
import { CAXRI_PROTOCOL_VERSION } from '../shared/ipc/version';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 2 * MAX_MESSAGE_BYTES;
const HANDSHAKE_TIMEOUT_MS = 2_000;
const DESKTOP_LEASE_MS = 60_000;
const DESKTOP_COMMAND_TIMEOUT_MS = 15_000;

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function tokenMatches(candidate: string, expected: string): boolean {
    const candidateDigest = createHash('sha256').update(candidate).digest();
    const expectedDigest = createHash('sha256').update(expected).digest();
    return timingSafeEqual(candidateDigest, expectedDigest);
}

function operatorContext(profileId: string): CommandExecutionContext {
    return {
        capabilities: [
            'desktop.window',
            'diagnostics.read',
            'agents.read',
            'agents.control',
            'agents.dispatch',
            'agents.grant',
            'events.read',
            'host.read',
            'host.stop',
            'projects.read',
            'sessions.read',
            'settings.read',
            'settings.write',
            'terminals.read',
            'terminals.steer',
        ],
        /** The authenticated profile is the retry identity across short-lived CLI connections. */
        principal: { kind: 'human-cli', id: `human-cli:${profileId}` },
    };
}

async function executeReply(
    id: string,
    action: () => Promise<unknown>,
): Promise<CommandReplyEnvelope> {
    try {
        return {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id,
            ok: true,
            result: await action(),
        };
    } catch (error) {
        return {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id,
            ok: false,
            error: toWireError(error),
        };
    }
}

interface ClientState {
    context: CommandExecutionContext;
    desktopLease?: DesktopLease;
    desktopReady: boolean;
    inFlightRequestIds: Set<string>;
    leaseTimer?: NodeJS.Timeout;
    socket: Socket;
}

interface PendingDesktopCommand {
    reject(error: CaxriError): void;
    resolve(value: unknown): void;
    state: ClientState;
    timer: NodeJS.Timeout;
}

interface DesktopLeaseWaiter {
    reject(error: CaxriError): void;
    resolve(lease: DesktopLease): void;
    timer: NodeJS.Timeout;
}

export interface LocalHostServerOptions {
    adapters: CommandDispatcherOptions;
    authenticateAgent?(credential: {
        hostId: string;
        endpointId: string;
        generation: number;
        token: string;
    }): CommandExecutionContext;
    consumeDesktopTarget?(targetId: string, generation: number): Promise<DesktopTargetPayload>;
    desktopCredential: HostDesktopCredential;
    invokeDesktopRuntime?(request: RuntimeRequest): Promise<unknown>;
    manifest: HostManifest;
    onClientCountChanged?(count: number): void;
    onDesktopUnavailable?(): void;
    onReplyFlushed?(
        request: LocalClientCommand['request'],
        reply: LocalServerReply['reply'],
        context: CommandExecutionContext,
    ): void;
    onRequestDisconnected?(requestId: string, context: CommandExecutionContext): void;
    refreshContext?(context: CommandExecutionContext): CommandExecutionContext;
}

/** Authenticated, profile-scoped UDS adapter for Desktop and human CLI clients. */
export class LocalHostServer {
    private readonly clients = new Map<Socket, ClientState>();
    private readonly sockets = new Set<Socket>();
    private readonly dispatch: CommandDispatcher;
    private readonly pendingDesktopCommands = new Map<string, PendingDesktopCommand>();
    private readonly desktopLeaseWaiters = new Set<DesktopLeaseWaiter>();
    private currentDesktop?: ClientState;
    private desktopGeneration = 0;
    private server?: Server;

    constructor(private readonly options: LocalHostServerOptions) {
        this.dispatch = createCommandDispatcher(options.adapters);
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

    /** Routes one typed window operation to exactly the current Desktop generation. */
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

    async start(): Promise<void> {
        if (this.server) return;
        try {
            const existing = await lstat(this.options.manifest.endpoint);
            if (!existing.isSocket())
                throw new CaxriError('PATH_DENIED', 'Host endpoint path is not a Unix socket');
            throw new CaxriError('CONFLICT', 'Host endpoint is already in use');
        } catch (error) {
            if (fileSystemCode(error) !== 'ENOENT') throw error;
        }
        const server = createServer((socket) => this.accept(socket));
        this.server = server;
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error): void => {
                    server.off('listening', onListening);
                    reject(error);
                };
                const onListening = (): void => {
                    server.off('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(this.options.manifest.endpoint);
            });
            await chmod(this.options.manifest.endpoint, 0o600);
        } catch (error) {
            this.server = undefined;
            if (server.listening)
                await new Promise<void>((resolve) => server.close(() => resolve()));
            if (error instanceof CaxriError) throw error;
            if (fileSystemCode(error) === 'EADDRINUSE')
                throw new CaxriError('CONFLICT', 'Host endpoint is already in use');
            throw new CaxriError('IO', 'Host endpoint failed to listen');
        }
    }

    broadcast(event: ProtocolEventEnvelope | TransientRuntimeEvent): void {
        const message = localServerEventSchema.parse({ type: 'event', event });
        /** Raw Runtime payloads are a Desktop-only transport; other principals use projections. */
        if (this.currentDesktop?.desktopReady) this.write(this.currentDesktop.socket, message);
    }

    /** Delivers a transient, body-free receipt only to the exact authenticated Agent generation. */
    broadcastAgent(endpoint: AgentEndpointRef, event: TransientRuntimeEvent): void {
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

    /** Delivers a one-shot Host UI event without placing it in the recoverable Runtime journal. */
    broadcastDesktop(event: TransientRuntimeEvent): void {
        const message = localServerEventSchema.parse({ type: 'event', event });
        if (this.currentDesktop?.desktopReady) this.write(this.currentDesktop.socket, message);
    }

    private revokeDesktop(state: ClientState, notifyUnavailable = true): void {
        if (state.leaseTimer) clearTimeout(state.leaseTimer);
        state.leaseTimer = undefined;
        this.rejectDesktopCommands(state);
        this.clients.delete(state.socket);
        const wasCurrent = this.currentDesktop === state;
        if (wasCurrent) this.currentDesktop = undefined;
        this.options.onClientCountChanged?.(this.clients.size);
        if (wasCurrent && notifyUnavailable) this.options.onDesktopUnavailable?.();
    }

    private renewDesktop(state: ClientState): DesktopLease {
        const lease = state.desktopLease;
        if (!lease || this.currentDesktop !== state)
            throw new CaxriError('CONFLICT', 'Desktop capability lease is stale');
        if (state.leaseTimer) clearTimeout(state.leaseTimer);
        const renewed = { ...lease, expiresAt: Date.now() + DESKTOP_LEASE_MS };
        state.desktopLease = renewed;
        state.leaseTimer = setTimeout(() => this.revokeDesktop(state), DESKTOP_LEASE_MS);
        state.leaseTimer.unref();
        return renewed;
    }

    private accept(socket: Socket): void {
        this.sockets.add(socket);
        socket.setEncoding('utf8');
        socket.setNoDelay(true);
        const handshakeTimer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
        let state: ClientState | undefined;
        let source = '';
        let queue = Promise.resolve();

        const remove = (): void => {
            clearTimeout(handshakeTimer);
            this.sockets.delete(socket);
            if (!state) return;
            for (const requestId of state.inFlightRequestIds)
                this.options.onRequestDisconnected?.(requestId, state.context);
            state.inFlightRequestIds.clear();
            if (!this.clients.has(socket)) return;
            if (state.desktopLease) this.revokeDesktop(state);
            else {
                this.clients.delete(socket);
                this.options.onClientCountChanged?.(this.clients.size);
            }
        };
        socket.on('close', remove);
        socket.on('error', () => undefined);
        socket.on('data', (chunk: string) => {
            source += chunk;
            if (Buffer.byteLength(source, 'utf8') > MAX_SOCKET_BUFFER_BYTES) {
                socket.destroy();
                return;
            }
            let newline = source.indexOf('\n');
            while (newline !== -1) {
                const line = source.slice(0, newline);
                source = source.slice(newline + 1);
                if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
                    socket.destroy();
                    return;
                }
                let raw: unknown;
                try {
                    raw = JSON.parse(line) as unknown;
                } catch {
                    socket.destroy();
                    return;
                }
                /** Reverse replies must settle outside the per-client command queue to avoid a
                 * Desktop request deadlocking while Host routes a nested window operation back. */
                if (state && this.settleDesktopReply(state, raw)) {
                    newline = source.indexOf('\n');
                    continue;
                }
                queue = queue
                    .then(async () => {
                        if (!state) {
                            const hello = localClientHelloSchema.parse(raw);
                            const manifest = this.options.manifest;
                            if (hello.profileId !== manifest.profileId) {
                                socket.destroy();
                                return;
                            }
                            let context: CommandExecutionContext;
                            let desktopLease: DesktopLease | undefined;
                            if (hello.credential.kind === 'operator') {
                                if (!tokenMatches(hello.credential.token, manifest.operatorToken)) {
                                    socket.destroy();
                                    return;
                                }
                                context = operatorContext(manifest.profileId);
                            } else if (hello.credential.kind === 'agent') {
                                if (!this.options.authenticateAgent) {
                                    socket.destroy();
                                    return;
                                }
                                try {
                                    context = this.options.authenticateAgent(hello.credential);
                                } catch {
                                    socket.destroy();
                                    return;
                                }
                            } else {
                                const credential = this.options.desktopCredential;
                                if (
                                    credential.profileId !== manifest.profileId ||
                                    credential.processIdentity !== manifest.processIdentity ||
                                    !tokenMatches(hello.credential.token, credential.desktopToken)
                                ) {
                                    socket.destroy();
                                    return;
                                }
                                const generation = ++this.desktopGeneration;
                                desktopLease = {
                                    desktopId: hello.credential.desktopId,
                                    generation,
                                    expiresAt: Date.now() + DESKTOP_LEASE_MS,
                                };
                                context = {
                                    capabilities: ['desktop'],
                                    principal: {
                                        kind: 'desktop',
                                        id: hello.credential.desktopId,
                                        generation,
                                    },
                                };
                                if (this.currentDesktop)
                                    this.revokeDesktop(this.currentDesktop, false);
                            }
                            state = {
                                context,
                                desktopLease,
                                desktopReady: false,
                                inFlightRequestIds: new Set(),
                                socket,
                            };
                            clearTimeout(handshakeTimer);
                            this.clients.set(socket, state);
                            if (desktopLease) {
                                this.currentDesktop = state;
                                this.renewDesktop(state);
                            }
                            this.options.onClientCountChanged?.(this.clients.size);
                            this.write(
                                socket,
                                localServerWelcomeSchema.parse({
                                    type: 'welcome',
                                    profileId: manifest.profileId,
                                    processIdentity: manifest.processIdentity,
                                    ...(desktopLease ? { desktopLease: state.desktopLease } : {}),
                                    ...createProtocolWelcome(
                                        this.options.adapters,
                                        hello,
                                        state.context,
                                    ),
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
                                principal.kind !== 'desktop' ||
                                this.currentDesktop !== clientState ||
                                !desktopLease ||
                                desktopLease.generation !== ready.data.generation
                            )
                                throw new CaxriError(
                                    'CONFLICT',
                                    'Desktop capability lease is stale',
                                );
                            clientState.desktopReady = true;
                            for (const waiter of this.desktopLeaseWaiters) {
                                clearTimeout(waiter.timer);
                                waiter.resolve(desktopLease);
                            }
                            this.desktopLeaseWaiters.clear();
                            return;
                        }
                        const renew = localClientLeaseRenewSchema.safeParse(raw);
                        if (renew.success) {
                            const principal = clientState.context.principal;
                            const leaseGeneration = clientState.desktopLease?.generation;
                            if (
                                principal.kind !== 'desktop' ||
                                leaseGeneration !== renew.data.generation
                            )
                                throw new CaxriError(
                                    'CONFLICT',
                                    'Desktop capability lease is stale',
                                );
                            this.write(
                                socket,
                                localServerLeaseRenewedSchema.parse({
                                    type: 'desktop-lease.renewed',
                                    lease: this.renewDesktop(clientState),
                                }),
                            );
                            return;
                        }
                        const runtimeCommand =
                            localClientDesktopRuntimeCommandSchema.safeParse(raw);
                        if (runtimeCommand.success) {
                            const reply = await executeReply(
                                runtimeCommand.data.request.id,
                                async () => {
                                    if (
                                        clientState.context.principal.kind !== 'desktop' ||
                                        this.currentDesktop !== clientState
                                    )
                                        throw new CaxriError(
                                            'CONFLICT',
                                            'Desktop capability lease is stale',
                                        );
                                    if (!this.options.invokeDesktopRuntime)
                                        throw new CaxriError(
                                            'UNAVAILABLE',
                                            'Desktop Runtime bridge is unavailable',
                                        );
                                    const request = parseRuntimeRequest(
                                        runtimeCommand.data.request.method,
                                        runtimeCommand.data.request.params,
                                    );
                                    return this.options.invokeDesktopRuntime(request);
                                },
                            );
                            this.write(
                                socket,
                                localServerDesktopRuntimeReplySchema.parse({
                                    type: 'desktop-runtime-reply',
                                    reply,
                                }),
                            );
                            return;
                        }
                        const consume = localClientDesktopTargetConsumeSchema.safeParse(raw);
                        if (consume.success) {
                            const reply = await executeReply(consume.data.id, async () => {
                                if (
                                    clientState.context.principal.kind !== 'desktop' ||
                                    this.currentDesktop !== clientState ||
                                    clientState.desktopLease?.generation !== consume.data.generation
                                )
                                    throw new CaxriError(
                                        'CONFLICT',
                                        'Desktop capability lease is stale',
                                    );
                                if (!this.options.consumeDesktopTarget)
                                    throw new CaxriError(
                                        'UNAVAILABLE',
                                        'Desktop target bridge is unavailable',
                                    );
                                return this.options.consumeDesktopTarget(
                                    consume.data.targetId,
                                    consume.data.generation,
                                );
                            });
                            this.write(
                                socket,
                                localServerDesktopTargetReplySchema.parse({
                                    type: 'desktop-target.reply',
                                    reply,
                                }),
                            );
                            return;
                        }
                        const command = localClientCommandSchema.parse(raw);
                        const commandRequest = command.request;
                        clientState.inFlightRequestIds.add(commandRequest.id);
                        let currentContext: CommandExecutionContext;
                        try {
                            currentContext =
                                this.options.refreshContext?.(clientState.context) ??
                                clientState.context;
                        } catch (error) {
                            const reply = {
                                protocolVersion: CAXRI_PROTOCOL_VERSION,
                                id: commandRequest.id,
                                ok: false as const,
                                error: toWireError(error),
                            };
                            this.write(
                                socket,
                                localServerReplySchema.parse({ type: 'reply', reply }),
                                () => {
                                    clientState.inFlightRequestIds.delete(commandRequest.id);
                                    this.options.onReplyFlushed?.(
                                        commandRequest,
                                        reply,
                                        clientState.context,
                                    );
                                },
                            );
                            return;
                        }
                        const reply =
                            currentContext.principal.kind === 'desktop' &&
                            this.currentDesktop !== clientState
                                ? {
                                      protocolVersion: CAXRI_PROTOCOL_VERSION,
                                      id: commandRequest.id,
                                      ok: false as const,
                                      error: toWireError(
                                          new CaxriError(
                                              'CONFLICT',
                                              'Desktop capability lease is stale',
                                          ),
                                      ),
                                  }
                                : await this.dispatch(commandRequest, currentContext);
                        this.write(
                            socket,
                            localServerReplySchema.parse({ type: 'reply', reply }),
                            () => {
                                clientState.inFlightRequestIds.delete(commandRequest.id);
                                this.options.onReplyFlushed?.(
                                    commandRequest,
                                    reply,
                                    currentContext,
                                );
                            },
                        );
                    })
                    .catch(() => {
                        socket.destroy();
                    });
                newline = source.indexOf('\n');
            }
        });
    }

    private write(socket: Socket, message: unknown, flushed?: () => void): void {
        if (socket.destroyed || socket.writableLength > MAX_SOCKET_BUFFER_BYTES) {
            socket.destroy();
            return;
        }
        socket.write(`${JSON.stringify(message)}\n`, flushed);
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
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        this.clients.clear();
        if (this.currentDesktop?.leaseTimer) clearTimeout(this.currentDesktop.leaseTimer);
        this.currentDesktop = undefined;
        this.options.onClientCountChanged?.(0);
        const server = this.server;
        this.server = undefined;
        if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}
