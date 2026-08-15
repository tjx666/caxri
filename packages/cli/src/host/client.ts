import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';

import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    desktopTargetPayloadSchema,
    fromWireError,
    hostDesktopCredentialSchema,
    hostManifestSchema,
    localClientDesktopReplySchema,
    localClientDesktopReadySchema,
    localServerDesktopCommandSchema,
    localServerDesktopRuntimeReplySchema,
    localServerDesktopTargetReplySchema,
    localServerEventSchema,
    localServerLeaseRenewedSchema,
    localServerReplySchema,
    localServerWelcomeSchema,
    LocalJsonLineDecoder,
    parseCaxriRequest,
    parseCaxriResult,
    parseRuntimeRequest,
    parseRuntimeResult,
    isNonExpiringRuntimeMethod,
    toWireError,
    type CaxriMethod,
    type DesktopLease,
    type DesktopOperation,
    type DesktopRuntimeMethod,
    type DesktopRuntimeMethodResult,
    type DesktopRuntimeParamsArg,
    type DesktopTargetPayload,
    type HostDesktopCredential,
    type HostManifest,
    type LocalServerEvent,
    type LocalServerDesktopCommand,
    type MethodResult,
    type ParamsArg,
    type ProtocolWelcome,
} from '@caxri/protocol';

const MAX_MANIFEST_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const LAUNCH_ENVIRONMENT_KEYS = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'SSH_AUTH_SOCK',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'CLAUDE_CONFIG_DIR',
] as const;

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

/** Host shutdown may unlink discovery data after `lstat`; keep that race classified as absence. */
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

/** Reads only the private discovery record; business state always goes through Host commands. */
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
    let metadata;
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
    if (Buffer.byteLength(parsed.data.endpoint, 'utf8') > 103)
        throw new CaxriError('VALIDATION', 'Caxri Host endpoint exceeds the platform limit');
    return parsed.data;
}

/** Reads the Desktop-only credential and binds it to the current Host process identity. */
export async function discoverDesktopCredential(
    userDataPath: string,
    manifest: HostManifest,
): Promise<HostDesktopCredential> {
    const canonicalPath = await realpath(userDataPath);
    const path = join(canonicalPath, 'host', 'desktop-credential.json');
    let metadata;
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

/** Authenticated local client shared by the CLI command surface and its future Agent adapter. */
export class HostClient {
    private readonly decoder = new LocalJsonLineDecoder();
    private readonly eventListeners = new Set<(event: LocalServerEvent['event']) => void>();
    private readonly pending = new Map<string, PendingRequest>();
    private closed = false;
    private leaseRenewalTimer?: NodeJS.Timeout;
    desktopLease?: DesktopLease;

    private constructor(
        private readonly socket: Socket,
        readonly welcome: ProtocolWelcome,
        private readonly timeoutMs: number,
        desktopLease?: DesktopLease,
        private readonly desktopCommandHandler?: Extract<
            HostClientCredential,
            { kind: 'desktop' }
        >['handleCommand'],
    ) {
        this.desktopLease = desktopLease;
        socket.on('data', (chunk: Buffer | string) => this.receive(chunk.toString()));
        socket.on('close', () => this.failPending());
        socket.on('error', () => this.failPending());
        if (desktopLease) {
            this.leaseRenewalTimer = setInterval(() => {
                const generation = this.desktopLease?.generation;
                if (!generation || this.closed) return;
                this.socket.write(
                    `${JSON.stringify({ type: 'desktop-lease.renew', generation })}\n`,
                );
            }, 20_000);
            this.leaseRenewalTimer.unref();
        }
    }

    static async connect(
        manifest: HostManifest,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        credential: HostClientCredential = { kind: 'operator' },
    ): Promise<HostClient> {
        if (manifest.protocolVersion !== CAXRI_PROTOCOL_VERSION)
            throw new CaxriError('CONFLICT', 'Caxri Host protocol version is incompatible', {
                clientProtocolVersion: CAXRI_PROTOCOL_VERSION,
                hostProtocolVersion: manifest.protocolVersion,
            });
        try {
            const endpoint = await lstat(manifest.endpoint);
            if (
                !endpoint.isSocket() ||
                (endpoint.mode & 0o077) !== 0 ||
                (typeof process.getuid === 'function' && endpoint.uid !== process.getuid())
            )
                throw new CaxriError('PATH_DENIED', 'Caxri Host endpoint is not private');
        } catch (error) {
            if (error instanceof CaxriError) throw error;
            if (fileSystemCode(error) === 'ENOENT')
                throw new CaxriError('UNAVAILABLE', 'Caxri Host endpoint is unavailable');
            throw error;
        }
        const socket = createConnection(manifest.endpoint);
        socket.setEncoding('utf8');
        socket.setNoDelay(true);
        const handshake = await new Promise<{
            desktopLease?: DesktopLease;
            remainder: string;
            welcome: ProtocolWelcome;
        }>((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new CaxriError('TIMEOUT', 'Caxri Host handshake timed out'));
            }, timeoutMs);
            let source = '';
            const fail = (): void => {
                clearTimeout(timer);
                reject(new CaxriError('UNAVAILABLE', 'Caxri Host is unavailable'));
            };
            socket.once('error', fail);
            socket.once('close', fail);
            socket.on('data', (chunk: Buffer | string) => {
                source += chunk.toString();
                if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
                    socket.destroy();
                    return;
                }
                const newline = source.indexOf('\n');
                if (newline === -1) return;
                try {
                    const message = localServerWelcomeSchema.parse(
                        JSON.parse(source.slice(0, newline)),
                    );
                    if (
                        message.profileId !== manifest.profileId ||
                        message.processIdentity !== manifest.processIdentity
                    )
                        throw new CaxriError('CONFLICT', 'Caxri Host process identity changed');
                    clearTimeout(timer);
                    socket.pause();
                    socket.removeListener('error', fail);
                    socket.removeListener('close', fail);
                    socket.removeAllListeners('data');
                    resolve({
                        remainder: source.slice(newline + 1),
                        welcome: message,
                        ...(message.desktopLease ? { desktopLease: message.desktopLease } : {}),
                    });
                } catch (error) {
                    clearTimeout(timer);
                    socket.destroy();
                    reject(
                        error instanceof CaxriError
                            ? error
                            : new CaxriError('VALIDATION', 'Caxri Host handshake was invalid'),
                    );
                }
            });
            socket.once('connect', () => {
                socket.write(
                    `${JSON.stringify({
                        type: 'hello',
                        supportedVersions: [CAXRI_PROTOCOL_VERSION],
                        profileId: manifest.profileId,
                        credential:
                            credential.kind === 'operator'
                                ? { kind: 'operator', token: manifest.operatorToken }
                                : credential.kind === 'agent'
                                  ? credential
                                  : {
                                        kind: 'desktop',
                                        token: credential.credential.desktopToken,
                                        desktopId: credential.desktopId,
                                    },
                    })}\n`,
                );
            });
        });
        const client = new HostClient(
            socket,
            handshake.welcome,
            timeoutMs,
            handshake.desktopLease,
            credential.kind === 'desktop'
                ? (operation, consumeTarget) => credential.handleCommand(operation, consumeTarget)
                : undefined,
        );
        client.receive(handshake.remainder);
        socket.resume();
        return client;
    }

    private receive(chunk: string): void {
        let lines: string[];
        try {
            lines = this.decoder.push(chunk);
        } catch {
            this.close();
            return;
        }
        for (const line of lines) {
            try {
                const raw = JSON.parse(line) as unknown;
                const renewed = localServerLeaseRenewedSchema.safeParse(raw);
                const event = localServerEventSchema.safeParse(raw);
                if (renewed.success) {
                    if (
                        !this.desktopLease ||
                        renewed.data.lease.desktopId !== this.desktopLease.desktopId ||
                        renewed.data.lease.generation !== this.desktopLease.generation
                    )
                        throw new Error('Desktop lease renewal does not match this connection');
                    this.desktopLease = renewed.data.lease;
                } else if (event.success) {
                    for (const listener of this.eventListeners) listener(event.data.event);
                } else {
                    const desktopCommand = localServerDesktopCommandSchema.safeParse(raw);
                    if (desktopCommand.success) {
                        void this.handleDesktopCommand(desktopCommand.data);
                        continue;
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
                this.close();
                return;
            }
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
        } catch (cause) {
            error = cause;
        }
        if (this.closed) return;
        this.socket.write(
            `${JSON.stringify(
                localClientDesktopReplySchema.parse({
                    type: 'desktop-reply',
                    generation: command.lease.generation,
                    reply: error
                        ? {
                              protocolVersion: CAXRI_PROTOCOL_VERSION,
                              id: command.request.id,
                              ok: false,
                              error: toWireError(error),
                          }
                        : {
                              protocolVersion: CAXRI_PROTOCOL_VERSION,
                              id: command.request.id,
                              ok: true,
                              result: result ?? null,
                          },
                }),
            )}\n`,
        );
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
            this.socket.write(
                `${JSON.stringify({
                    type: 'desktop-target.consume',
                    generation: lease.generation,
                    id,
                    targetId,
                })}\n`,
            );
        });
    }

    requestRuntime<M extends DesktopRuntimeMethod>(
        method: M,
        ...args: DesktopRuntimeParamsArg<M>
    ): Promise<DesktopRuntimeMethodResult<M>> {
        if (this.closed)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Caxri Host connection is closed'));
        if (!this.desktopLease)
            return Promise.reject(new CaxriError('FORBIDDEN', 'Desktop lease is required'));
        const [params, timeoutOverride] = args;
        const request = parseRuntimeRequest(method, params);
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CaxriError('TIMEOUT', `Desktop Runtime request timed out: ${method}`));
            }, timeoutOverride ?? this.timeoutMs);
            this.pending.set(id, {
                parse: (value) => parseRuntimeResult(method, value),
                resolve: (value) => resolve(value as DesktopRuntimeMethodResult<M>),
                reject,
                timer,
            });
            this.socket.write(
                `${JSON.stringify({
                    type: 'desktop-runtime-command',
                    request: {
                        protocolVersion: CAXRI_PROTOCOL_VERSION,
                        id,
                        method: request.method,
                        params: request.params,
                    },
                })}\n`,
            );
        });
    }

    private failPending(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.leaseRenewalTimer) clearInterval(this.leaseRenewalTimer);
        this.leaseRenewalTimer = undefined;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new CaxriError('UNAVAILABLE', 'Caxri Host connection closed'));
        }
        this.pending.clear();
    }

    request<M extends CaxriMethod>(method: M, ...args: ParamsArg<M>): Promise<MethodResult<M>>;
    request(method: CaxriMethod, params: unknown): Promise<unknown>;
    request(method: CaxriMethod, params?: unknown): Promise<unknown> {
        return this.sendRequest(randomUUID(), method, params);
    }

    /** Preserves the caller's transport request ID across the Desktop-to-Host hop. */
    requestWithId<M extends CaxriMethod>(
        id: string,
        method: M,
        ...args: ParamsArg<M>
    ): Promise<MethodResult<M>>;
    requestWithId(id: string, method: CaxriMethod, params: unknown): Promise<unknown>;
    requestWithId(id: string, method: CaxriMethod, params?: unknown): Promise<unknown> {
        return this.sendRequest(id, method, params);
    }

    private sendRequest(id: string, method: CaxriMethod, params: unknown): Promise<unknown> {
        if (this.closed)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Caxri Host connection is closed'));
        const request = parseCaxriRequest(method, params);
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
            this.socket.write(
                `${JSON.stringify({
                    type: 'command',
                    request: {
                        protocolVersion: CAXRI_PROTOCOL_VERSION,
                        id,
                        method: request.method,
                        params: request.params,
                    },
                })}\n`,
            );
        });
    }

    onEvent(listener: (event: LocalServerEvent['event']) => void): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    /** Announces that Main has an attached Renderer event listener for one-shot window commands. */
    markDesktopReady(): Promise<void> {
        const lease = this.desktopLease;
        if (this.closed)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Caxri Host connection is closed'));
        if (!lease) return Promise.reject(new CaxriError('FORBIDDEN', 'Desktop lease is required'));
        return new Promise((resolve, reject) => {
            this.socket.write(
                `${JSON.stringify(
                    localClientDesktopReadySchema.parse({
                        type: 'desktop.ready',
                        generation: lease.generation,
                    }),
                )}\n`,
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

    close(): void {
        this.socket.destroy();
        this.failPending();
    }
}

export async function connectToHost(
    userDataPath: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    credential: Extract<HostClientCredential, { kind: 'operator' | 'agent' }> = {
        kind: 'operator',
    },
): Promise<HostClient> {
    return HostClient.connect(await discoverHostManifest(userDataPath), timeoutMs, credential);
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

export interface HostLaunchOptions {
    /** Electron binary, or the packaged Caxri executable with the RunAsNode fuse enabled. */
    executable: string;
    /** Built `host.js`, including an app.asar path for the packaged Desktop shim. */
    entryPath: string;
    environment?: NodeJS.ProcessEnv;
}

function safeLaunchEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of LAUNCH_ENVIRONMENT_KEYS)
        if (process.env[key] !== undefined) environment[key] = process.env[key];
    return { ...environment, ...overrides };
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return fileSystemCode(error) !== 'ESRCH';
    }
}

async function launchHost(userDataPath: string, options: HostLaunchOptions): Promise<void> {
    await mkdir(userDataPath, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const child = spawn(options.executable, [options.entryPath], {
            detached: true,
            env: {
                ...safeLaunchEnvironment(options.environment),
                CAXRI_USER_DATA_PATH: userDataPath,
                ELECTRON_RUN_AS_NODE: '1',
            },
            stdio: 'ignore',
        });
        child.once('error', () =>
            reject(new CaxriError('UNAVAILABLE', 'Caxri Host process failed to launch')),
        );
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

/** Reuses a healthy owner or launches exactly one contender and waits for authenticated readiness. */
export async function ensureHost(
    userDataPath: string,
    launch: HostLaunchOptions,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HostClient> {
    const deadline = Date.now() + timeoutMs;
    let launched = false;
    while (Date.now() < deadline) {
        let manifest: HostManifest | undefined;
        try {
            manifest = await discoverHostManifest(userDataPath);
        } catch (error) {
            if (!(error instanceof CaxriError) || error.code !== 'NOT_FOUND') throw error;
        }
        /** An incompatible live Host fails closed and requires the explicit pre-release reset tool.
         * If its recorded process is already gone, no PTY owner remains to protect and the stale
         * discovery record must not permanently block launching the current Host. The profile lock
         * arbitrates the replacement; this path never signals or removes another process. */
        if (
            manifest &&
            manifest.protocolVersion !== CAXRI_PROTOCOL_VERSION &&
            !processIsAlive(manifest.pid)
        )
            manifest = undefined;
        if (manifest) {
            try {
                return await HostClient.connect(
                    manifest,
                    Math.max(1, Math.min(2_000, deadline - Date.now())),
                );
            } catch (error) {
                if (!(error instanceof CaxriError) || error.code !== 'UNAVAILABLE') throw error;
                if (processIsAlive(manifest.pid))
                    throw new CaxriError(
                        'CONFLICT',
                        'Caxri Host process is alive but its authenticated endpoint is unavailable',
                    );
            }
        }
        if (!launched) {
            await launchHost(userDataPath, launch);
            launched = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new CaxriError('TIMEOUT', 'Caxri Host did not become ready before the deadline');
}
