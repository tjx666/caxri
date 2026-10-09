import { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';

import { CaxriError } from '@caxri/protocol';

/**
 * Largest single protocol frame accepted from the provider. A resumed thread returns its whole history in one response,
 * so the bound is generous, but an unbounded buffer would let a misbehaving child exhaust Server Core memory.
 */
const CODEX_MAX_FRAME_BYTES = 32 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;

/**
 * Closed reasons for a connection that ended. Each one maps to a Chat failure or an orderly stop.
 */
export type CodexConnectionEnd =
    | { reason: 'closed' }
    | { reason: 'spawnFailed'; code?: string }
    | { reason: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null }
    | { reason: 'frameTooLarge' }
    | { reason: 'writeFailed' };

export interface CodexServerRequest {
    id: number | string;
    method: string;
    params: Record<string, unknown>;
}

interface CodexConnectionHandlers {
    onNotification(method: string, parameters: Record<string, unknown>): void;
    onServerRequest(request: CodexServerRequest): void;
    onEnd(end: CodexConnectionEnd): void;
}

export interface CodexConnectionOptions {
    executable: string;
    args: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    handlers: CodexConnectionHandlers;
    /**
     * Test seam for a fake child process. Always called with piped stdio.
     */
    spawnProcess?: (
        executable: string,
        arguments_: string[],
        options: SpawnOptionsWithoutStdio,
    ) => ChildProcessWithoutNullStreams;
}

/**
 * Error the provider returned for one request. `message` is provider text and must not be logged.
 */
export class CodexRequestError extends Error {
    constructor(
        readonly code: number | undefined,
        message: string,
    ) {
        super(message);
    }
}

interface PendingRequest {
    resolve(result: unknown): void;
    reject(error: Error): void;
    timer?: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One newline-delimited JSON-RPC connection to `codex app-server` over stdio. The app-server omits the `jsonrpc` field,
 * so frames are classified by shape: `id` + `method` is a server request, `method` alone a notification, and `id` with
 * `result` or `error` a response.
 *
 * @see https://github.com/openai/codex/tree/main/codex-rs/app-server
 */
export class CodexConnection {
    private readonly child: ChildProcessWithoutNullStreams;

    private readonly pending = new Map<number, PendingRequest>();

    private nextId = 1;

    private buffer = '';

    private readonly decoder = new StringDecoder('utf8');

    private hasEnded = false;

    private readonly exited: Promise<void>;

    /**
     * Lifetime aggregates reported once when the process exits.
     */
    readonly counters = { droppedFrames: 0, serverRequests: 0, notifications: 0 };

    constructor(private readonly options: CodexConnectionOptions) {
        const spawnProcess = options.spawnProcess ?? spawn;
        this.child = spawnProcess(options.executable, [...options.args], {
            cwd: options.cwd,
            env: options.environment,
            stdio: ['pipe', 'pipe', 'pipe'],
            /**
             * A process group lets termination reach an npm-installed `codex` shim's native child too.
             */
            detached: process.platform !== 'win32',
        });
        this.exited = new Promise((resolve) => {
            this.child.once('close', () => resolve());
            this.child.once('error', () => resolve());
        });
        this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
        /**
         * Stderr carries provider tracing that may quote conversation content; drain it without retaining it.
         */
        this.child.stderr.resume();
        this.child.stdin.on('error', () => this.end({ reason: 'writeFailed' }));
        this.child.once('error', (error: NodeJS.ErrnoException) =>
            this.end({ reason: 'spawnFailed', code: error.code }),
        );
        this.child.once('close', (exitCode, signal) =>
            this.end({ reason: 'exited', exitCode, signal }),
        );
    }

    private async exitsWithin(timeoutMs: number): Promise<boolean> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
        });
        const exit = (async () => {
            await this.exited;
            return true as const;
        })();
        try {
            return await Promise.race([exit, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    private hasExited(): boolean {
        return this.child.exitCode !== null || this.child.signalCode !== null;
    }

    private signal(signal: NodeJS.Signals): void {
        const pid = this.child.pid;
        if (pid === undefined) return;
        try {
            if (process.platform === 'win32') this.child.kill(signal);
            else process.kill(-pid, signal);
        } catch {
            try {
                this.child.kill(signal);
            } catch {
                // Already exited.
            }
        }
    }

    private write(message: Record<string, unknown>): void {
        if (this.hasEnded) return;
        try {
            this.child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch {
            this.end({ reason: 'writeFailed' });
        }
    }

    private receive(chunk: Buffer): void {
        if (this.hasEnded) return;
        this.buffer += this.decoder.write(chunk);
        let newline = this.buffer.indexOf('\n');
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            this.handleLine(line);
            // A handler may have ended the connection; TypeScript cannot see that through the call.
            if (!this.isOpen) return;
            newline = this.buffer.indexOf('\n');
        }
        if (Buffer.byteLength(this.buffer) > CODEX_MAX_FRAME_BYTES) {
            this.end({ reason: 'frameTooLarge' });
            this.signal('SIGKILL');
        }
    }

    private handleLine(line: string): void {
        if (!line.trim()) return;
        let frame: unknown;
        try {
            frame = JSON.parse(line);
        } catch {
            this.counters.droppedFrames += 1;
            return;
        }
        if (!isRecord(frame)) {
            this.counters.droppedFrames += 1;
            return;
        }
        const { id, method } = frame;
        const parameters = isRecord(frame.params) ? frame.params : {};
        if (typeof method === 'string') {
            if (typeof id === 'number' || typeof id === 'string') {
                this.counters.serverRequests += 1;
                this.options.handlers.onServerRequest({ id, method, params: parameters });
            } else {
                this.counters.notifications += 1;
                this.options.handlers.onNotification(method, parameters);
            }
            return;
        }
        if (typeof id !== 'number') {
            this.counters.droppedFrames += 1;
            return;
        }
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        if (isRecord(frame.error)) {
            const { code, message } = frame.error;
            entry.reject(
                new CodexRequestError(
                    typeof code === 'number' ? code : undefined,
                    typeof message === 'string' ? message : 'Codex app-server request failed',
                ),
            );
        } else entry.resolve(frame.result);
    }

    private end(end: CodexConnectionEnd): void {
        if (this.hasEnded) return;
        this.hasEnded = true;
        for (const entry of this.pending.values()) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.reject(new CaxriError('UNAVAILABLE', 'Codex app-server stopped'));
        }
        this.pending.clear();
        this.options.handlers.onEnd(end);
    }

    get pid(): number | undefined {
        return this.child.pid;
    }

    get isOpen(): boolean {
        return !this.hasEnded;
    }

    /**
     * Sends one request. `timeoutMs` bounds handshake-style calls; a turn's own lifetime is never bounded here.
     */
    request(method: string, parameters: unknown, timeoutMs?: number): Promise<unknown> {
        if (this.hasEnded)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Codex app-server is not running'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const entry: PendingRequest = { resolve, reject };
            if (timeoutMs !== undefined) {
                entry.timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new CaxriError('TIMEOUT', `Codex app-server ${method} timed out`));
                }, timeoutMs);
                entry.timer.unref();
            }
            this.pending.set(id, entry);
            this.write({ id, method, params: parameters });
        });
    }

    notify(method: string, parameters?: unknown): void {
        this.write(parameters === undefined ? { method } : { method, params: parameters });
    }

    respond(id: number | string, result: unknown): void {
        this.write({ id, result });
    }

    respondError(id: number | string, code: number, message: string): void {
        this.write({ id, error: { code, message } });
    }

    /**
     * Closes stdin (the app-server exits on EOF), then escalates to SIGTERM and SIGKILL on the process group.
     */
    async close(): Promise<void> {
        this.end({ reason: 'closed' });
        try {
            this.child.stdin.end();
        } catch {
            // Already closed.
        }
        if (this.child.pid === undefined || this.hasExited()) return this.exited;
        if ((await this.exitsWithin(TERMINATION_GRACE_MS)) || this.hasExited()) return;
        this.signal('SIGTERM');
        if (!(await this.exitsWithin(TERMINATION_GRACE_MS)) && !this.hasExited())
            this.signal('SIGKILL');
        await this.exited;
    }
}
