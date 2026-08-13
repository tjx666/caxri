import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';

import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    fromWireError,
    hostManifestSchema,
    localServerEventSchema,
    localServerReplySchema,
    localServerWelcomeSchema,
    parseCaxriRequest,
    parseCaxriResult,
    type CaxriMethod,
    type HostManifest,
    type LocalServerEvent,
    type MethodResult,
    type ParamsArg,
    type ProtocolWelcome,
} from '@caxri/protocol';

const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
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
    method: CaxriMethod;
    reject(error: Error): void;
    resolve(value: unknown): void;
    timer: NodeJS.Timeout;
}

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function profileIdFor(path: string): string {
    return createHash('sha256').update(path).digest('hex').slice(0, 24);
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
    let source: unknown;
    try {
        source = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
        throw new CaxriError('VALIDATION', 'Caxri Host discovery metadata is malformed');
    }
    const parsed = hostManifestSchema.safeParse(source);
    if (!parsed.success)
        throw new CaxriError('VALIDATION', 'Caxri Host discovery metadata is invalid');
    if (parsed.data.profileId !== profileIdFor(canonicalPath))
        throw new CaxriError('CONFLICT', 'Caxri Host discovery profile identity does not match');
    if (Buffer.byteLength(parsed.data.endpoint, 'utf8') > 103)
        throw new CaxriError('VALIDATION', 'Caxri Host endpoint exceeds the platform limit');
    return parsed.data;
}

/** Authenticated local client shared by the CLI command surface and its future Agent adapter. */
export class HostClient {
    private readonly eventListeners = new Set<(event: LocalServerEvent['event']) => void>();
    private readonly pending = new Map<string, PendingRequest>();
    private source = '';
    private closed = false;

    private constructor(
        private readonly socket: Socket,
        readonly welcome: ProtocolWelcome,
        private readonly timeoutMs: number,
    ) {
        socket.on('data', (chunk: Buffer | string) => this.receive(chunk.toString()));
        socket.on('close', () => this.failPending());
        socket.on('error', () => this.failPending());
    }

    static async connect(
        manifest: HostManifest,
        timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<HostClient> {
        if (manifest.protocolVersion !== CAXRI_PROTOCOL_VERSION)
            throw new CaxriError('CONFLICT', 'Caxri Host protocol version is incompatible');
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
        socket.setNoDelay(true);
        const handshake = await new Promise<{ remainder: string; welcome: ProtocolWelcome }>(
            (resolve, reject) => {
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
                    if (Buffer.byteLength(source, 'utf8') > MAX_MESSAGE_BYTES) {
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
                        resolve({ remainder: source.slice(newline + 1), welcome: message });
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
                            ownerToken: manifest.ownerToken,
                            clientKind: 'human-cli',
                        })}\n`,
                    );
                });
            },
        );
        const client = new HostClient(socket, handshake.welcome, timeoutMs);
        client.source = handshake.remainder;
        client.receive('');
        socket.resume();
        return client;
    }

    private receive(chunk: string): void {
        this.source += chunk;
        if (Buffer.byteLength(this.source, 'utf8') > 2 * MAX_MESSAGE_BYTES) {
            this.close();
            return;
        }
        let newline = this.source.indexOf('\n');
        while (newline !== -1) {
            const line = this.source.slice(0, newline);
            this.source = this.source.slice(newline + 1);
            try {
                const raw = JSON.parse(line) as unknown;
                const event = localServerEventSchema.safeParse(raw);
                if (event.success) {
                    for (const listener of this.eventListeners) listener(event.data.event);
                } else {
                    const { reply } = localServerReplySchema.parse(raw);
                    if (!reply.id) throw new Error('Reply is missing its request ID');
                    const pending = this.pending.get(reply.id);
                    if (pending) {
                        clearTimeout(pending.timer);
                        this.pending.delete(reply.id);
                        if (reply.ok)
                            pending.resolve(parseCaxriResult(pending.method, reply.result));
                        else pending.reject(fromWireError(reply.error));
                    }
                }
            } catch {
                this.close();
                return;
            }
            newline = this.source.indexOf('\n');
        }
    }

    private failPending(): void {
        if (this.closed) return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new CaxriError('UNAVAILABLE', 'Caxri Host connection closed'));
        }
        this.pending.clear();
    }

    request<M extends CaxriMethod>(method: M, ...args: ParamsArg<M>): Promise<MethodResult<M>> {
        if (this.closed)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Caxri Host connection is closed'));
        const request = parseCaxriRequest(method, args[0]);
        const id = randomUUID();
        return new Promise<MethodResult<M>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CaxriError('TIMEOUT', `Caxri Host request timed out: ${method}`));
            }, this.timeoutMs);
            this.pending.set(id, {
                method,
                resolve: (value) => resolve(value as MethodResult<M>),
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

    close(): void {
        this.socket.destroy();
        this.failPending();
    }
}

export async function connectToHost(
    userDataPath: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HostClient> {
    return HostClient.connect(await discoverHostManifest(userDataPath), timeoutMs);
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
