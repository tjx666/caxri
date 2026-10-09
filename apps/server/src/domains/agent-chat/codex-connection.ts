import { Buffer } from 'node:buffer';

import { CaxriError } from '@caxri/protocol';

import type { ChatProcessEnd, SpawnChatProcess } from './chat-provider';
import { ProviderProcess } from './provider-process';

/**
 * Largest single protocol frame accepted from the provider. A resumed thread returns its whole history in one response,
 * so the bound is generous, but an unbounded buffer would let a misbehaving child exhaust Server Core memory.
 */
const CODEX_MAX_FRAME_BYTES = 32 * 1024 * 1024;
/**
 * Bytes Caxri may queue on the provider's stdin. Outgoing frames are small (a message is at most 100k characters), so a
 * provider this far behind has stopped reading and the connection is failed instead of buffering without limit.
 */
const CODEX_MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface CodexServerRequest {
    id: number | string;
    method: string;
    params: Record<string, unknown>;
}

interface CodexConnectionHandlers {
    onNotification(method: string, parameters: Record<string, unknown>): void;
    onServerRequest(request: CodexServerRequest): void;
    onEnd(end: ChatProcessEnd): void;
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
    spawnProcess?: SpawnChatProcess;
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
    private readonly process: ProviderProcess;

    private readonly pending = new Map<number, PendingRequest>();

    private nextId = 1;

    /**
     * Raw bytes of the frame still being received. Frames are split on the newline byte before decoding (UTF-8 never
     * uses 0x0a inside a multi-byte sequence), so the size bound is exact and checked before anything is parsed.
     */
    private partial: Buffer[] = [];

    private partialBytes = 0;

    private hasEnded = false;

    /**
     * Lifetime aggregates reported once when the process exits.
     */
    readonly counters = { droppedFrames: 0, serverRequests: 0, notifications: 0 };

    constructor(private readonly options: CodexConnectionOptions) {
        this.process = new ProviderProcess(options);
        const { child } = this.process;
        child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
        child.stdin.on('error', () => this.end({ reason: 'writeFailed' }));
        child.once('error', (error: NodeJS.ErrnoException) =>
            this.end({ reason: 'spawnFailed', code: error.code }),
        );
        child.once('close', (exitCode, signal) => this.end({ reason: 'exited', exitCode, signal }));
    }

    private write(message: Record<string, unknown>): void {
        if (this.hasEnded) return;
        if (this.process.child.stdin.writableLength > CODEX_MAX_PENDING_WRITE_BYTES) {
            this.end({ reason: 'writeFailed' });
            this.process.signal('SIGKILL');
            return;
        }
        try {
            this.process.child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch {
            this.end({ reason: 'writeFailed' });
        }
    }

    /**
     * Fails the connection for a frame past {@link CODEX_MAX_FRAME_BYTES}. Returns `true` when it did.
     */
    private rejectsOversizedFrame(bytes: number): boolean {
        if (bytes <= CODEX_MAX_FRAME_BYTES) return false;
        this.partial = [];
        this.partialBytes = 0;
        this.end({ reason: 'frameTooLarge' });
        this.process.signal('SIGKILL');
        return true;
    }

    private receive(chunk: Buffer): void {
        if (this.hasEnded) return;
        let start = 0;
        let newline = chunk.indexOf(NEWLINE);
        while (newline !== -1) {
            const tail = chunk.subarray(start, newline);
            if (this.rejectsOversizedFrame(this.partialBytes + tail.length)) return;
            const frame = this.partial.length > 0 ? Buffer.concat([...this.partial, tail]) : tail;
            this.partial = [];
            this.partialBytes = 0;
            this.handleLine(frame.toString('utf8'));
            // A handler may have ended the connection; TypeScript cannot see that through the call.
            if (!this.isOpen) return;
            start = newline + 1;
            newline = chunk.indexOf(NEWLINE, start);
        }
        if (start === chunk.length) return;
        const rest = chunk.subarray(start);
        if (this.rejectsOversizedFrame(this.partialBytes + rest.length)) return;
        this.partial.push(rest);
        this.partialBytes += rest.length;
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

    private end(end: ChatProcessEnd): void {
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
        return this.process.pid;
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
        await this.process.terminate();
    }
}
