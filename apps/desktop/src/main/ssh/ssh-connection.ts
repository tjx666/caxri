import { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';

import type { RemoteFailureReason } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { ensurePrivateUnixSocketDirectory } from '@caxri/system';
import { notifyListeners } from '@caxri/utils';

import type { SshDestination } from './destination';
import { sshDestinationArguments, sshDestinationKey } from './destination';
import { shellQuote } from './shell-quote';

const DEFAULT_SSH_EXECUTABLE = '/usr/bin/ssh';
/**
 * Keeps the last OpenSSH diagnostics without letting a chatty `-v` config or banner grow Main's memory.
 */
const MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/**
 * Linux caps a single argv string at 128 KiB (`MAX_ARG_STRLEN`), and sshd passes the remote command to the login shell
 * as one argument. Scripts stay far below that; larger payloads travel on stdin.
 */
const MAX_REMOTE_COMMAND_BYTES = 96 * 1024;
const CONTROL_COMMAND_TIMEOUT_MS = 10_000;
/**
 * A master may sit on an askpass prompt while the user types a password or reads a host key, so readiness is bounded
 * generously; `ConnectTimeout` already bounds the network part.
 */
const DEFAULT_READY_TIMEOUT_MS = 5 * 60_000;
const FORWARD_ATTEMPTS = 5;
/**
 * `<destination key>.<Main pid>.<random>`: unique per connection, and the pid lets a later Desktop find masters a
 * crashed Main left behind.
 */
const CONTROL_SOCKET_PATTERN = /^[0-9a-f]{12}\.(\d+)\.[0-9a-f]+$/u;

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the pid exists but belongs to another user.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Short private root for ControlMaster sockets. macOS limits `sun_path` to 104 bytes and OpenSSH appends a 17-byte
 * temporary suffix while it binds, so the per-user `TMPDIR` (about 49 bytes on its own) is too long; `/tmp` plus a
 * uid-owned 0700 directory keeps the full path near 40 bytes.
 */
export function defaultSshControlDirectory(): string {
    return join('/tmp', `caxri-ssh-${process.getuid?.() ?? 0}`);
}

export class SshConnectionError extends Error {
    constructor(
        readonly reason: RemoteFailureReason,
        message: string,
    ) {
        super(message);
        this.name = 'SshConnectionError';
    }
}

/**
 * Lines OpenSSH prints for each failure class. Matching is on stable fragments that have not changed across OpenSSH 7.x
 * to 10.x; anything else is `unknown` and still shows OpenSSH's own last line.
 */
const FAILURE_PATTERNS: ReadonlyArray<readonly [RemoteFailureReason, RegExp]> = [
    [
        'hostKey',
        /host key verification failed|remote host identification has changed|host key for .* has changed|no .*host key is known/iu,
    ],
    [
        'authentication',
        /permission denied|too many authentication failures|authentication failed|no supported authentication methods|keyboard-interactive/iu,
    ],
    [
        'unreachable',
        /could not resolve hostname|name or service not known|connection refused|connection timed out|operation timed out|no route to host|network is unreachable|connection closed by|connection reset|kex_exchange_identification|banner exchange|proxycommand|broken pipe/iu,
    ],
];

function lastMeaningfulLine(stderr: string): string {
    const lines = stderr
        .split(/\r?\n/u)
        // eslint-disable-next-line no-control-regex -- strip terminal control characters from OpenSSH output
        .map((line) => line.replaceAll(/[\u{0}-\u{1F}\u{7F}]/gu, '').trim())
        .filter((line) => line !== '');
    return (lines.at(-1) ?? '').slice(0, 2000);
}

/**
 * Classifies a failed `ssh` run from its stderr into the closed protocol reason, keeping OpenSSH's last line as the
 * user-visible message.
 */
export function classifySshFailure(stderr: string): {
    message: string;
    reason: RemoteFailureReason;
} {
    const message = lastMeaningfulLine(stderr) || 'SSH exited without an error message';
    for (const [reason, pattern] of FAILURE_PATTERNS)
        if (pattern.test(stderr)) return { message, reason };
    return { message, reason: 'unknown' };
}

/**
 * The remote command for a POSIX `sh` script. sshd hands this string to the user's login shell, which may be fish, zsh,
 * or tcsh; the base64 alphabet, single quotes, and `$(...)` inside single quotes parse identically in all of them, and
 * `sh` then evaluates the decoded script. stdin stays free for upload streams.
 */
export function remoteShellCommand(script: string): string {
    const encoded = Buffer.from(script, 'utf8').toString('base64');
    const command = `sh -c ${shellQuote(`eval "$(echo ${encoded} | base64 -d)"`)}`;
    if (Buffer.byteLength(command) > MAX_REMOTE_COMMAND_BYTES)
        throw new Error('Remote script is too large for one SSH command');
    return command;
}

class BoundedText {
    private chunks: Buffer[] = [];
    private size = 0;

    constructor(private readonly limit: number) {}

    push(chunk: Buffer): void {
        this.chunks.push(chunk);
        this.size += chunk.length;
        while (this.size > this.limit && this.chunks.length > 1) {
            const removed = this.chunks.shift();
            this.size -= removed?.length ?? 0;
        }
    }

    text(): string {
        const joined = Buffer.concat(this.chunks);
        return joined.subarray(Math.max(0, joined.length - this.limit)).toString('utf8');
    }
}

export interface SshExecOptions {
    maxOutputBytes?: number;
    /**
     * Upload payload piped to the remote script's stdin.
     */
    stdin?: Readable;
    timeoutMs: number;
}

export interface SshExecResult {
    code: number | null;
    stderr: string;
    stdout: string;
}

export interface SshConnectionCloseInfo {
    code: number | null;
    message: string;
    signal: NodeJS.Signals | null;
}

export interface SshConnectionOptions {
    /**
     * Optional `ssh -F` file. Main sets it from `CAXRI_SSH_CONFIG` for tests and acceptance so they never read the
     * user's `~/.ssh/config`.
     */
    configFile?: string;
    connectTimeoutSeconds?: number;
    /**
     * Private 0700 directory for the control socket; created and verified by `start()`.
     */
    controlDirectory: string;
    destination: SshDestination;
    /**
     * Extra environment for the master, such as the askpass bridge variables.
     */
    environment?: Record<string, string>;
    readyPollIntervalMs?: number;
    readyTimeoutMs?: number;
    sshExecutable?: string;
}

interface ControlResult {
    code: number | null;
    stderr: string;
}

/**
 * One OpenSSH ControlMaster for one destination, owned by Desktop Main. The user authenticates once when the master
 * connects; every probe, script, upload, and port forward afterwards multiplexes over it, so none of them can prompt.
 *
 * Each connection owns its own socket path. Two windows on the same SSH Host therefore run two masters: a shared path
 * would make the second window's start treat the first window's live master as stale and close it.
 */
export class SshConnection {
    private master?: ChildProcess;
    private masterStderr = new BoundedText(MAX_STDERR_BYTES);
    private isReady = false;
    private isStopping = false;
    private readonly closeListeners = new Set<(info: SshConnectionCloseInfo) => void>();
    private readonly forwards = new Map<number, number>();
    private readonly sshExecutable: string;
    readonly controlPath: string;

    constructor(private readonly options: SshConnectionOptions) {
        if (options.controlDirectory.includes('%'))
            throw new Error('SSH control directory must not contain "%"');
        this.sshExecutable = options.sshExecutable ?? DEFAULT_SSH_EXECUTABLE;
        this.controlPath = join(
            options.controlDirectory,
            `${sshDestinationKey(options.destination, options.configFile)}.${process.pid}.${randomBytes(4).toString('hex')}`,
        );
    }

    private configArguments(): string[] {
        return this.options.configFile === undefined ? [] : ['-F', this.options.configFile];
    }

    private environment(): NodeJS.ProcessEnv {
        return { ...process.env, ...this.options.environment };
    }

    /**
     * Runs an `ssh -O <command>` control request against the master socket.
     */
    private async control(
        command: string,
        extra: string[] = [],
        controlPath = this.controlPath,
    ): Promise<ControlResult> {
        const child = spawn(
            this.sshExecutable,
            [
                ...this.configArguments(),
                '-o',
                `ControlPath=${controlPath}`,
                '-O',
                command,
                ...extra,
                ...sshDestinationArguments(this.options.destination),
            ],
            { env: this.environment(), stdio: ['ignore', 'ignore', 'pipe'] },
        );
        const stderr = new BoundedText(MAX_STDERR_BYTES);
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        return new Promise<ControlResult>((resolve) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), CONTROL_COMMAND_TIMEOUT_MS);
            child.once('error', (error) => {
                clearTimeout(timer);
                resolve({ code: null, stderr: error.message });
            });
            child.once('close', (code) => {
                clearTimeout(timer);
                resolve({ code, stderr: stderr.text() });
            });
        });
    }

    private async socketExists(path = this.controlPath): Promise<boolean> {
        try {
            return (await lstat(path)).isSocket();
        } catch {
            return false;
        }
    }

    /**
     * Masters left behind by a Main that crashed before stopping them keep their network connection open forever
     * (`ControlPersist=no` only ends a master whose client exits, and an orphaned master has none). Their sockets carry
     * the dead Main's pid, so they are asked to exit and removed. Sockets of live processes, including other windows of
     * this Main, are never touched.
     */
    private async closeOrphanedMasters(): Promise<void> {
        let names: string[];
        try {
            names = await readdir(this.options.controlDirectory);
        } catch {
            return;
        }
        const orphaned = names.filter((name) => {
            const pid = Number(CONTROL_SOCKET_PATTERN.exec(name)?.[1] ?? NaN);
            return Number.isSafeInteger(pid) && pid !== process.pid && !isProcessAlive(pid);
        });
        await Promise.all(
            orphaned.map(async (name) => {
                const path = join(this.options.controlDirectory, name);
                if (await this.socketExists(path)) await this.control('exit', [], path);
                await rm(path, { force: true });
            }),
        );
    }

    private handleMasterExit(master: ChildProcess, info: SshConnectionCloseInfo): void {
        if (this.master !== master) return;
        const wasReady = this.isReady;
        this.isReady = false;
        this.forwards.clear();
        if (!wasReady || this.isStopping) return;
        notifyListeners(this.closeListeners, info);
    }

    /**
     * Read through a method rather than the `isOpen` getter inside this class: TypeScript keeps a getter narrowed by an
     * earlier `if (!this.isOpen) throw` across later `await`s, but the master can exit at any point in between.
     */
    private hasLiveMaster(): boolean {
        return this.isReady && this.master?.exitCode === null;
    }

    get isOpen(): boolean {
        return this.hasLiveMaster();
    }

    /**
     * Starts the ControlMaster and resolves once `ssh -O check` succeeds, after closing masters a crashed Desktop left
     * behind.
     */
    async start(): Promise<void> {
        if (this.master) throw new Error('SSH connection was already started');
        await ensurePrivateUnixSocketDirectory(this.options.controlDirectory);
        await this.closeOrphanedMasters();
        const master = spawn(
            this.sshExecutable,
            [
                ...this.configArguments(),
                '-M',
                '-N',
                '-T',
                '-o',
                'ControlMaster=yes',
                '-o',
                'ControlPersist=no',
                '-o',
                `ControlPath=${this.controlPath}`,
                '-o',
                'ServerAliveInterval=15',
                '-o',
                'ServerAliveCountMax=3',
                '-o',
                `ConnectTimeout=${this.options.connectTimeoutSeconds ?? 15}`,
                '-o',
                'RemoteCommand=none',
                '-o',
                'RequestTTY=no',
                // Drops `LocalForward`/`RemoteForward` from the user's config for this host; mux `-O forward`
                // requests are still honored (verified against OpenSSH 10).
                '-o',
                'ClearAllForwardings=yes',
                ...sshDestinationArguments(this.options.destination),
            ],
            { env: this.environment(), stdio: ['ignore', 'ignore', 'pipe'] },
        );
        this.master = master;
        master.stderr.on('data', (chunk: Buffer) => this.masterStderr.push(chunk));
        const exited = new Promise<SshConnectionCloseInfo>((resolve) => {
            master.once('error', (error) => {
                this.masterStderr.push(Buffer.from(`\n${error.message}\n`));
                resolve({ code: null, message: error.message, signal: null });
            });
            master.once('close', (code, signal) =>
                resolve({
                    code,
                    message: lastMeaningfulLine(this.masterStderr.text()),
                    signal,
                }),
            );
        });
        // eslint-disable-next-line no-void -- close notification is observed independently of readiness.
        void exited.then((info) => this.handleMasterExit(master, info));

        const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
        const interval = this.options.readyPollIntervalMs ?? 100;
        let hasExited = false;
        // eslint-disable-next-line no-void -- flag only; the exit itself is handled above.
        void exited.then(() => {
            hasExited = true;
        });
        /**
         * The flag flips in a callback while this loop awaits; reading it through a function keeps TypeScript from
         * treating it as still `false` after the `await`.
         */
        const hasMasterExited = (): boolean => hasExited;
        while (!hasExited) {
            if (Date.now() > deadline) {
                // eslint-disable-next-line no-await-in-loop -- terminal branch: the loop ends with this throw.
                await this.stop();
                throw new SshConnectionError('unreachable', 'SSH connection timed out');
            }
            // eslint-disable-next-line no-await-in-loop -- readiness is polled sequentially.
            if (await this.socketExists()) {
                // eslint-disable-next-line no-await-in-loop -- see above.
                const check = await this.control('check');
                if (!hasMasterExited() && check.code === 0) {
                    this.isReady = true;
                    return;
                }
            }
            // eslint-disable-next-line no-await-in-loop -- bounded polling interval.
            await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, interval))]);
        }
        if (this.isStopping)
            throw new SshConnectionError('cancelled', 'SSH connection was stopped');
        const failure = classifySshFailure(this.masterStderr.text());
        throw new SshConnectionError(failure.reason, failure.message);
    }

    /**
     * Notifies when an established master exits on its own (network loss, remote reboot, `ServerAlive` timeout). An
     * explicit `stop()` does not notify.
     */
    onClose(listener: (info: SshConnectionCloseInfo) => void): () => void {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    /**
     * Runs a POSIX `sh` script on the remote through the master. A non-zero exit is returned, not thrown, so callers
     * can map script-specific exit codes; only transport problems and timeouts throw.
     */
    async exec(script: string, options: SshExecOptions): Promise<SshExecResult> {
        if (!this.isOpen)
            throw new SshConnectionError('connectionLost', 'SSH connection is closed');
        const command = remoteShellCommand(script);
        const child = spawn(
            this.sshExecutable,
            [
                ...this.configArguments(),
                '-o',
                `ControlPath=${this.controlPath}`,
                '-o',
                'ControlMaster=no',
                // A client must never prompt: if the master vanished, fail instead of opening a second login.
                '-o',
                'BatchMode=yes',
                '-T',
                '-o',
                'RemoteCommand=none',
                '-o',
                'RequestTTY=no',
                '-o',
                'ClearAllForwardings=yes',
                ...sshDestinationArguments(this.options.destination),
                command,
            ],
            {
                env: this.environment(),
                stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            },
        );
        const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        const stdout: Buffer[] = [];
        let stdoutBytes = 0;
        /**
         * Set from stream and timer callbacks; an object keeps TypeScript from narrowing the flags to their initial
         * `false` across the `await` below.
         */
        const termination = { isOverflowed: false, isTimedOut: false };
        const stderr = new BoundedText(MAX_STDERR_BYTES);
        child.stdout?.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxOutputBytes) {
                termination.isOverflowed = true;
                child.kill('SIGKILL');
                return;
            }
            stdout.push(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        if (options.stdin && child.stdin) {
            // A remote script that exits early closes the pipe; its exit code reports why, so EPIPE is not an error.
            child.stdin.on('error', () => {});
            options.stdin.on('error', () => child.kill('SIGKILL'));
            options.stdin.pipe(child.stdin);
        }
        const timer = setTimeout(() => {
            termination.isTimedOut = true;
            child.kill('SIGKILL');
        }, options.timeoutMs);
        const { code, spawnError } = await new Promise<{
            code: number | null;
            spawnError?: Error;
        }>((resolve) => {
            child.once('error', (error) => resolve({ code: null, spawnError: error }));
            child.once('close', (exitCode) => resolve({ code: exitCode }));
            // `close` waits for stdio to end, which a descendant that inherited the pipes (a `ProxyCommand`, for
            // example) can hold open after `ssh` itself was killed; a killed command settles on `exit` instead.
            child.once('exit', (exitCode) => {
                if (termination.isTimedOut || termination.isOverflowed) resolve({ code: exitCode });
            });
        });
        clearTimeout(timer);
        if (options.stdin && child.stdin) options.stdin.unpipe(child.stdin);
        if (spawnError) throw new SshConnectionError('unknown', spawnError.message);
        if (termination.isTimedOut) throw new CaxriError('TIMEOUT', 'Remote command timed out');
        if (termination.isOverflowed)
            throw new CaxriError('VALIDATION', 'Remote command output is too large');
        // 255 is OpenSSH's own failure status; a master lost mid-command surfaces here.
        if (code === 255 && !this.hasLiveMaster())
            throw new SshConnectionError('connectionLost', lastMeaningfulLine(stderr.text()));
        return { code, stderr: stderr.text(), stdout: Buffer.concat(stdout).toString('utf8') };
    }

    /**
     * Adds a loopback forward from a free local port to `127.0.0.1:<remotePort>` on the SSH Host. The free port is
     * chosen by binding port 0 and releasing it, so another process can take it before OpenSSH binds; that race is
     * retried with a fresh port.
     */
    async forwardLocal(remotePort: number): Promise<number> {
        if (!this.isOpen)
            throw new SshConnectionError('connectionLost', 'SSH connection is closed');
        let lastMessage = '';
        for (let attempt = 0; attempt < FORWARD_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- each retry needs a new candidate port.
            const localPort = await reserveLoopbackPort();
            // eslint-disable-next-line no-await-in-loop -- one forward request at a time.
            const result = await this.control('forward', [
                '-L',
                `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
            ]);
            if (result.code === 0) {
                this.forwards.set(localPort, remotePort);
                return localPort;
            }
            lastMessage = lastMeaningfulLine(result.stderr);
            if (!/forwarding failed|address already in use|cannot listen/iu.test(result.stderr))
                break;
        }
        throw new SshConnectionError(
            this.hasLiveMaster() ? 'unknown' : 'connectionLost',
            lastMessage || 'SSH port forward failed',
        );
    }

    async cancelForward(localPort: number): Promise<void> {
        const remotePort = this.forwards.get(localPort);
        if (remotePort === undefined) return;
        this.forwards.delete(localPort);
        if (!this.isOpen) return;
        await this.control('cancel', ['-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`]);
    }

    /**
     * Ends the master. `-O exit` lets OpenSSH close channels and remove its socket; the owned child is then signalled
     * in case the request could not be delivered.
     */
    async stop(): Promise<void> {
        this.isStopping = true;
        const master = this.master;
        if (master?.exitCode !== null || master.signalCode !== null) {
            this.isReady = false;
            return;
        }
        const exited = new Promise<boolean>((resolve) => master.once('close', () => resolve(true)));
        if (await this.socketExists()) await this.control('exit');
        const waitFor = (milliseconds: number): Promise<boolean> =>
            Promise.race([
                exited,
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
            ]);
        if (!(await waitFor(2000))) {
            master.kill('SIGTERM');
            if (!(await waitFor(2000))) master.kill('SIGKILL');
        }
        this.isReady = false;
        this.forwards.clear();
        await rm(this.controlPath, { force: true });
    }
}

/**
 * Picks a currently free loopback port by binding port 0 and releasing it.
 */
async function reserveLoopbackPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (typeof address !== 'object' || address === null)
        throw new Error('Could not reserve a loopback port');
    return address.port;
}
