import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type {
    CaxriMethod,
    DesktopLease,
    DesktopLeaseRevocationReason,
    DesktopOperation,
    DesktopRuntimeMethod,
    DesktopRuntimeMethodResult,
    DesktopRuntimeParametersArgument,
    DesktopTargetPayload,
    HostDesktopCredential,
    HostManifest,
    LocalServerDesktopCommand,
    LocalServerEvent,
    MethodResult,
    ParamsArg,
    ProtocolWelcome,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    CONTROL_TRANSPORT_MAX_FRAME_BYTES,
    desktopTargetPayloadSchema,
    fromWireError,
    hostDesktopCredentialSchema,
    hostEndpointUrl,
    hostManifestSchema,
    isNonExpiringRuntimeMethod,
    localClientDesktopReadySchema,
    localClientDesktopReplySchema,
    localServerDesktopCommandSchema,
    localServerDesktopLeaseRevokedSchema,
    localServerDesktopRuntimeReplySchema,
    localServerDesktopTargetReplySchema,
    localServerEventSchema,
    localServerLeaseRenewedSchema,
    localServerReplySchema,
    localServerWelcomeSchema,
    parseCaxriRequest,
    parseCaxriResult,
    parseRuntimeRequest,
    parseRuntimeResult,
    toWireError,
} from '@caxri/protocol';
import type { RawData } from 'ws';
import WebSocket from 'ws';

import type { HostLaunchOptions } from './launch.js';
import { launchHost } from './launch.js';

const MAX_MANIFEST_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
interface PendingRequest {
    parse(value: unknown): unknown;
    reject(error: Error): void;
    resolve(value: unknown): void;
    timer?: NodeJS.Timeout;
}

export type HostClientCredential =
    | { kind: 'operator' }
    | {
          kind: 'agent';
          hostId: string;
          endpointId: string;
          generation: number;
          token: string;
      }
    | {
          kind: 'desktop';
          desktopId: string;
          credential: HostDesktopCredential;
          handleCommand(
              operation: DesktopOperation,
              consumeTarget: () => Promise<DesktopTargetPayload>,
          ): Promise<unknown>;
      };

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function profileIdFor(path: string): string {
    return createHash('sha256').update(path).digest('hex').slice(0, 24);
}

function controlMessageText(data: RawData): string {
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return Buffer.concat(data).toString('utf8');
}

/**
 * Host shutdown may unlink discovery data after `lstat`; keep that race classified as absence.
 */
async function readDiscoveryJson(
    path: string,
    notFoundMessage: string,
    malformedMessage: string,
): Promise<unknown> {
    let contents: string;
    try {
        contents = await readFile(path, 'utf8');
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT') throw new CaxriError('NOT_FOUND', notFoundMessage);
        throw new CaxriError('VALIDATION', malformedMessage);
    }
    try {
        return JSON.parse(contents) as unknown;
    } catch {
        throw new CaxriError('VALIDATION', malformedMessage);
    }
}

/**
 * Reads only the private discovery record; business state always goes through Host commands.
 */
export async function discoverHostManifest(userDataPath: string): Promise<HostManifest> {
    let canonicalPath: string;
    try {
        canonicalPath = await realpath(userDataPath);
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT')
            throw new CaxriError('NOT_FOUND', 'The selected Caxri profile does not exist');
        throw error;
    }
    const directory = join(canonicalPath, 'host');
    const path = join(directory, 'manifest.json');
    let metadata: Stats;
    try {
        const directoryMetadata = await lstat(directory);
        if (
            !directoryMetadata.isDirectory() ||
            directoryMetadata.isSymbolicLink() ||
            (directoryMetadata.mode & 0o077) !== 0 ||
            (typeof process.getuid === 'function' && directoryMetadata.uid !== process.getuid())
        )
            throw new CaxriError('PATH_DENIED', 'Caxri Host discovery directory is not private');
        metadata = await lstat(path);
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT')
            throw new CaxriError('NOT_FOUND', 'No Caxri Host is running for this profile');
        throw error;
    }
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    )
        throw new CaxriError('PATH_DENIED', 'Caxri Host discovery metadata is not private');
    if (metadata.size > MAX_MANIFEST_BYTES)
        throw new CaxriError('VALIDATION', 'Caxri Host discovery metadata is oversized');
    const source = await readDiscoveryJson(
        path,
        'No Caxri Host is running for this profile',
        'Caxri Host discovery metadata is malformed',
    );
    const parsed = hostManifestSchema.safeParse(source);
    if (!parsed.success)
        throw new CaxriError('VALIDATION', 'Caxri Host discovery metadata is invalid');
    if (parsed.data.profileId !== profileIdFor(canonicalPath))
        throw new CaxriError('CONFLICT', 'Caxri Host discovery profile identity does not match');
    return parsed.data;
}

/**
 * Reads the Desktop-only credential and binds it to the current Host process identity.
 */
export async function discoverDesktopCredential(
    userDataPath: string,
    manifest: HostManifest,
): Promise<HostDesktopCredential> {
    const canonicalPath = await realpath(userDataPath);
    const path = join(canonicalPath, 'host', 'desktop-credential.json');
    let metadata: Stats;
    try {
        metadata = await lstat(path);
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT')
            throw new CaxriError('NOT_FOUND', 'Caxri Desktop credential is unavailable');
        throw error;
    }
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
        metadata.size > MAX_MANIFEST_BYTES
    )
        throw new CaxriError('PATH_DENIED', 'Caxri Desktop credential is not private');
    const source = await readDiscoveryJson(
        path,
        'Caxri Desktop credential is unavailable',
        'Caxri Desktop credential is malformed',
    );
    const parsed = hostDesktopCredentialSchema.safeParse(source);
    if (!parsed.success) throw new CaxriError('VALIDATION', 'Caxri Desktop credential is invalid');
    if (
        parsed.data.profileId !== manifest.profileId ||
        parsed.data.processIdentity !== manifest.processIdentity
    )
        throw new CaxriError('CONFLICT', 'Caxri Desktop credential belongs to another Host');
    return parsed.data;
}

/**
 * Authenticated local client shared by the CLI command surface and its future Agent adapter.
 */
export class HostClient {
    static async connect(
        manifest: HostManifest,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        credential?: HostClientCredential,
    ): Promise<HostClient> {
        if (manifest.protocolVersion !== CAXRI_PROTOCOL_VERSION)
            throw new CaxriError('CONFLICT', 'Caxri Host protocol version is incompatible', {
                clientProtocolVersion: CAXRI_PROTOCOL_VERSION,
                hostProtocolVersion: manifest.protocolVersion,
            });
        const resolvedCredential: HostClientCredential = credential ?? { kind: 'operator' };
        const socket = new WebSocket(hostEndpointUrl(manifest.endpoint), {
            maxPayload: CONTROL_TRANSPORT_MAX_FRAME_BYTES,
        });
        const deferredMessages: Array<{ data: RawData; isBinary: boolean }> = [];
        let isHandshakeComplete = false;
        let handshakeMessageListener: ((data: RawData, isBinary: boolean) => void) | undefined;
        const handshake = await new Promise<{
            desktopLease?: DesktopLease;
            welcome: ProtocolWelcome;
        }>((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.terminate();
                reject(new CaxriError('TIMEOUT', 'Caxri Host handshake timed out'));
            }, timeoutMs);
            const fail = (): void => {
                clearTimeout(timer);
                reject(new CaxriError('UNAVAILABLE', 'Caxri Host is unavailable'));
            };
            socket.once('error', fail);
            socket.once('close', fail);
            handshakeMessageListener = (data, isBinary): void => {
                if (isHandshakeComplete) {
                    deferredMessages.push({ data, isBinary });
                    return;
                }
                if (isBinary) {
                    socket.terminate();
                    return;
                }
                const source = controlMessageText(data);
                if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
                    socket.terminate();
                    return;
                }
                try {
                    const message = localServerWelcomeSchema.parse(JSON.parse(source));
                    if (
                        message.profileId !== manifest.profileId ||
                        message.processIdentity !== manifest.processIdentity
                    )
                        throw new CaxriError('CONFLICT', 'Caxri Host process identity changed');
                    clearTimeout(timer);
                    isHandshakeComplete = true;
                    socket.pause();
                    socket.removeListener('error', fail);
                    socket.removeListener('close', fail);
                    resolve({
                        welcome: message,
                        ...(message.desktopLease && { desktopLease: message.desktopLease }),
                    });
                } catch (error) {
                    clearTimeout(timer);
                    socket.terminate();
                    reject(
                        error instanceof CaxriError
                            ? error
                            : new CaxriError('VALIDATION', 'Caxri Host handshake was invalid'),
                    );
                }
            };
            socket.on('message', handshakeMessageListener);
            socket.once('open', () => {
                socket.send(
                    JSON.stringify({
                        type: 'hello',
                        supportedVersions: [CAXRI_PROTOCOL_VERSION],
                        profileId: manifest.profileId,
                        credential:
                            resolvedCredential.kind === 'operator'
                                ? { kind: 'operator', token: manifest.operatorToken }
                                : resolvedCredential.kind === 'agent'
                                  ? resolvedCredential
                                  : {
                                        kind: 'desktop',
                                        token: resolvedCredential.credential.desktopToken,
                                        desktopId: resolvedCredential.desktopId,
                                    },
                    }),
                );
            });
        });
        const client = new HostClient(
            socket,
            handshake.welcome,
            timeoutMs,
            handshake.desktopLease,
            resolvedCredential.kind === 'desktop'
                ? (operation, consumeTarget) =>
                      resolvedCredential.handleCommand(operation, consumeTarget)
                : undefined,
            manifest.version,
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
    private readonly closeListeners = new Set<(reason?: DesktopLeaseRevocationReason) => void>();
    private readonly pending = new Map<string, PendingRequest>();
    private closed = false;
    private closeReason?: DesktopLeaseRevocationReason;
    private leaseRenewalTimer?: NodeJS.Timeout;
    desktopLease?: DesktopLease;

    private constructor(
        private readonly socket: WebSocket,
        readonly welcome: ProtocolWelcome,
        private readonly timeoutMs: number,
        desktopLease?: DesktopLease,
        private readonly desktopCommandHandler?: Extract<
            HostClientCredential,
            { kind: 'desktop' }
        >['handleCommand'],
        readonly hostVersion?: string,
    ) {
        this.desktopLease = desktopLease;
        socket.on('message', (data, isBinary) => {
            if (isBinary) this.closeTransport();
            else this.receive(controlMessageText(data));
        });
        socket.on('close', () => this.failPending());
        socket.on('error', () => this.failPending());
        if (desktopLease) {
            this.leaseRenewalTimer = setInterval(() => {
                const generation = this.desktopLease?.generation;
                if (!generation || this.closed) return;
                this.send({ type: 'desktop-lease.renew', generation });
            }, 20_000);
            this.leaseRenewalTimer.unref();
        }
    }

    private receive(message: string): void {
        try {
            const raw = JSON.parse(message) as unknown;
            const renewed = localServerLeaseRenewedSchema.safeParse(raw);
            const revoked = localServerDesktopLeaseRevokedSchema.safeParse(raw);
            const event = localServerEventSchema.safeParse(raw);
            if (renewed.success) {
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
                for (const listener of this.eventListeners) listener(event.data.event);
            } else {
                const desktopCommand = localServerDesktopCommandSchema.safeParse(raw);
                if (desktopCommand.success) {
                    // `receive` is a synchronous socket data handler; the reply is written
                    // asynchronously from within `handleDesktopCommand` itself, so this call is
                    // intentionally fire-and-forget here.
                    // eslint-disable-next-line no-void
                    void this.handleDesktopCommand(desktopCommand.data);
                    return;
                }
                const runtimeReply = localServerDesktopRuntimeReplySchema.safeParse(raw);
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
            : new CaxriError('UNAVAILABLE', 'Caxri Host connection closed'),
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
        const listeners = [...this.closeListeners];
        this.closeListeners.clear();
        for (const listener of listeners) listener(this.closeReason);
    }

    private send(message: unknown, settled?: (error?: Error) => void): void {
        const source = JSON.stringify(message);
        const sourceBytes = Buffer.byteLength(source, 'utf8');
        if (
            this.socket.readyState !== WebSocket.OPEN ||
            this.socket.bufferedAmount + sourceBytes > CONTROL_TRANSPORT_MAX_FRAME_BYTES
        ) {
            const error = new CaxriError('UNAVAILABLE', 'Caxri Host connection is unavailable');
            settled?.(error);
            this.closeTransport();
            return;
        }
        this.socket.send(source, (error) => {
            settled?.(error);
            if (error) this.closeTransport();
        });
    }

    private sendRequest(id: string, method: CaxriMethod, parameters: unknown): Promise<unknown> {
        if (this.closed)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Caxri Host connection is closed'));
        const request = parseCaxriRequest(method, parameters);
        return new Promise<unknown>((resolve, reject) => {
            const timer = isNonExpiringRuntimeMethod(method)
                ? undefined
                : setTimeout(() => {
                      this.pending.delete(id);
                      reject(new CaxriError('TIMEOUT', `Caxri Host request timed out: ${method}`));
                  }, this.timeoutMs);
            this.pending.set(id, {
                parse: (value) => parseCaxriResult(method, value),
                resolve,
                reject,
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

    requestRuntime<M extends DesktopRuntimeMethod>(
        method: M,
        ...arguments_: DesktopRuntimeParametersArgument<M>
    ): Promise<DesktopRuntimeMethodResult<M>> {
        if (this.closed)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Caxri Host connection is closed'));
        if (!this.desktopLease)
            return Promise.reject(new CaxriError('FORBIDDEN', 'Desktop lease is required'));
        const [parameters, timeoutOverride] = arguments_;
        const request = parseRuntimeRequest(method, parameters);
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = isNonExpiringRuntimeMethod(method)
                ? undefined
                : setTimeout(() => {
                      this.pending.delete(id);
                      reject(
                          new CaxriError('TIMEOUT', `Desktop Runtime request timed out: ${method}`),
                      );
                  }, timeoutOverride ?? this.timeoutMs);
            this.pending.set(id, {
                parse: (value) => parseRuntimeResult(method, value),
                resolve: (value) => resolve(value as DesktopRuntimeMethodResult<M>),
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
        ...arguments_: ParamsArg<M>
    ): Promise<MethodResult<M>>;
    request(method: CaxriMethod, parameters: unknown): Promise<unknown>;
    request(method: CaxriMethod, parameters?: unknown): Promise<unknown> {
        return this.sendRequest(randomUUID(), method, parameters);
    }

    /**
     * Preserves the caller's transport request ID across the Desktop-to-Host hop.
     */
    requestWithId<M extends CaxriMethod>(
        id: string,
        method: M,
        ...arguments_: ParamsArg<M>
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
     * `close()`). An orderly Host lease takeover supplies `replaced`; other closures have no reason. A listener
     * registered after closure fires synchronously so callers cannot miss the transition.
     */
    onClose(listener: (reason?: DesktopLeaseRevocationReason) => void): () => void {
        if (this.closed) {
            listener(this.closeReason);
            return () => {};
        }
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    /**
     * Announces that Main has an attached Renderer event listener for one-shot window commands.
     */
    markDesktopReady(): Promise<void> {
        if (this.closed)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Caxri Host connection is closed'));
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
                ? new CaxriError('CANCELLED', 'Caxri Host client was disposed')
                : new CaxriError('UNAVAILABLE', 'Caxri Host connection closed'),
        );
        this.socket.close(1000);
    }
}

export async function connectToHost(
    userDataPath: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    credential?: Extract<HostClientCredential, { kind: 'operator' | 'agent' }>,
): Promise<HostClient> {
    return HostClient.connect(
        await discoverHostManifest(userDataPath),
        timeoutMs,
        credential ?? { kind: 'operator' },
    );
}

export async function connectDesktopToHost(
    userDataPath: string,
    desktopId: string,
    handleCommand: Extract<HostClientCredential, { kind: 'desktop' }>['handleCommand'],
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HostClient> {
    const manifest = await discoverHostManifest(userDataPath);
    const credential = await discoverDesktopCredential(userDataPath, manifest);
    return HostClient.connect(manifest, timeoutMs, {
        kind: 'desktop',
        desktopId,
        credential,
        handleCommand,
    });
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return fileSystemCode(error) !== 'ESRCH';
    }
}

/**
 * Reuses a healthy owner or launches exactly one contender and waits for authenticated readiness.
 */
export async function ensureHost(
    userDataPath: string,
    launch: HostLaunchOptions,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HostClient> {
    const deadline = Date.now() + timeoutMs;
    let isLaunched = false;
    while (Date.now() < deadline) {
        let manifest: HostManifest | undefined;
        try {
            // This polling loop must retry discovery/connect/launch sequentially against the same
            // profile lock on each iteration; the awaits cannot be parallelized across iterations.
            // eslint-disable-next-line no-await-in-loop
            manifest = await discoverHostManifest(userDataPath);
        } catch (error) {
            if (!(error instanceof CaxriError) || error.code !== 'NOT_FOUND') throw error;
        }
        /**
         * An incompatible live Host fails closed and requires the explicit pre-release reset tool. If its recorded
         * process is already gone, no PTY owner remains to protect and the stale discovery record must not permanently
         * block launching the current Host. The profile lock arbitrates the replacement; this path never signals or
         * removes another process.
         */
        if (
            manifest &&
            manifest.protocolVersion !== CAXRI_PROTOCOL_VERSION &&
            !isProcessAlive(manifest.pid)
        )
            manifest = undefined;
        if (manifest) {
            const connectTimeoutMs = Math.min(2_000, deadline - Date.now());
            try {
                // eslint-disable-next-line no-await-in-loop -- see the discovery-call justification above.
                return await HostClient.connect(manifest, Math.max(1, connectTimeoutMs));
            } catch (error) {
                if (!(error instanceof CaxriError) || error.code !== 'UNAVAILABLE') throw error;
                if (isProcessAlive(manifest.pid))
                    throw new CaxriError(
                        'CONFLICT',
                        'Caxri Host process is alive but its authenticated endpoint is unavailable',
                    );
            }
        }
        if (!isLaunched) {
            // eslint-disable-next-line no-await-in-loop -- see the discovery-call justification above.
            await launchHost(userDataPath, launch);
            isLaunched = true;
        }
        // eslint-disable-next-line no-await-in-loop -- see the discovery-call justification above.
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new CaxriError('TIMEOUT', 'Caxri Host did not become ready before the deadline');
}
