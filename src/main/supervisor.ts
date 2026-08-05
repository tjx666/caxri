import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { utilityProcess, type UtilityProcess } from 'electron';

import { CaxriError, fromWireError } from '../shared/ipc/errors';
import {
    parseRuntimeMessage,
    parseRuntimeResult,
    type RuntimeEvent,
    type RuntimeMessage,
    type RuntimeMethod,
    type RuntimeMethodResult,
    type RuntimeParamsArg,
} from '../shared/ipc';
import type { StructuredLogger } from '../shared/node/logger';
import { safeProcessEnvironment } from '../shared/node/process-environment';

interface PendingRequest {
    method: RuntimeMethod;
    resolve: (value: unknown) => void;
    reject: (error: CaxriError) => void;
    timer: NodeJS.Timeout;
}

interface RuntimeReadiness {
    promise: Promise<void>;
    reject: (error: CaxriError) => void;
    resolve: () => void;
}

type StdioStream = 'stdout' | 'stderr';

const RUNTIME_READY_TIMEOUT_MS = 15_000;
const RUNTIME_STABILITY_WINDOW_MS = 30_000;
/** Caps a single logged Runtime stdio line so a runaway native crash cannot log-bomb main.jsonl. */
const MAX_STDIO_LINE_LENGTH = 4_096;

function truncateForLog(text: string): string {
    return text.length > MAX_STDIO_LINE_LENGTH
        ? `${text.slice(0, MAX_STDIO_LINE_LENGTH)}…[truncated]`
        : text;
}

export class RuntimeSupervisor extends EventEmitter {
    private child?: UtilityProcess;
    private pending = new Map<string, PendingRequest>();
    private restartCount = 0;
    private intentionalStop = false;
    private terminalFailure?: CaxriError;
    private readiness?: RuntimeReadiness;
    private stabilityTimer?: NodeJS.Timeout;
    /** Set while a crash-triggered restart is waiting out its backoff delay; see `onExit`. */
    private pendingRestart?: Promise<void>;
    private readonly logger: StructuredLogger;
    private readonly stdioBuffers: Record<StdioStream, string> = { stdout: '', stderr: '' };

    constructor(
        private readonly runtimeDirectory: string,
        private readonly userDataPath: string,
        private readonly logDirectory: string,
        logger: StructuredLogger,
        private readonly logLevel: 'debug' | 'info' = 'debug',
    ) {
        super();
        /** Shares Main's own logger so Runtime stdio and Main records interleave in one main.jsonl file. */
        this.logger = logger;
    }

    processId(): number | undefined {
        return this.child?.pid;
    }

    start(): Promise<void> {
        /**
         * A request arriving while a crash-restart is scheduled must wait for that restart instead
         * of forking a second Runtime early, which would silently bypass the backoff delay.
         */
        if (this.pendingRestart) return this.pendingRestart;
        if (this.child) return this.readiness?.promise ?? Promise.resolve();
        if (this.terminalFailure) return Promise.reject(this.terminalFailure);
        if (this.intentionalStop)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Runtime has been stopped'));
        this.readiness ??= this.createReadiness();
        const runtimePath = join(this.runtimeDirectory, 'runtime.js');
        let child: UtilityProcess;
        try {
            child = utilityProcess.fork(runtimePath, [], {
                serviceName: 'Caxri Runtime',
                env: {
                    ...safeProcessEnvironment(),
                    CAXRI_LOG_DIRECTORY: this.logDirectory,
                    CAXRI_LOG_LEVEL: this.logLevel,
                    CAXRI_USER_DATA_PATH: this.userDataPath,
                    CAXRI_APP_VERSION: process.env.CAXRI_APP_VERSION ?? 'unknown',
                    CAXRI_GIT_COMMIT: process.env.CAXRI_GIT_COMMIT ?? 'unknown',
                },
                stdio: 'pipe',
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Runtime failed to start';
            const failure = new CaxriError('UNAVAILABLE', message);
            this.logger.write('error', 'runtime.error', { fields: { error: message } });
            this.onExit(-1);
            return this.readiness?.promise ?? Promise.reject(failure);
        }
        this.child = child;
        child.on('message', (message: unknown) => {
            if (this.child === child) this.onMessage(message);
        });
        child.on('exit', (code) => {
            if (this.child === child) this.onExit(code);
        });
        /**
         * Electron's `UtilityProcess` 'error' event is a non-continuable V8 fault, not a JS `Error`
         * object; it reports a fixed error type plus a diagnostic report, which can be large.
         */
        child.on('error', (type, location, report) =>
            this.logger.write('error', 'runtime.error', {
                fields: { type, location, report: truncateForLog(report) },
            }),
        );
        child.stdout?.on('data', (chunk: Buffer | string) => this.handleStdio('stdout', chunk));
        child.stderr?.on('data', (chunk: Buffer | string) => this.handleStdio('stderr', chunk));
        return this.readiness.promise;
    }

    /**
     * Buffers Runtime stdio until a line break, capping the buffer so a process that never emits a
     * newline cannot grow it unbounded, and writes each line as a structured log record instead of
     * the previous 'runtime-log'/'runtime-error' events, which nothing ever consumed.
     */
    private handleStdio(stream: StdioStream, chunk: Buffer | string): void {
        this.stdioBuffers[stream] += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let buffer = this.stdioBuffers[stream];
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
            this.logStdioLine(stream, buffer.slice(0, newlineIndex));
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf('\n');
        }
        if (buffer.length > MAX_STDIO_LINE_LENGTH) {
            this.logStdioLine(stream, buffer);
            buffer = '';
        }
        this.stdioBuffers[stream] = buffer;
    }

    private logStdioLine(stream: StdioStream, rawLine: string): void {
        const line = rawLine.replace(/\r$/, '');
        if (!line) return;
        /** `logger.write` already redacts secret-shaped field values before the line reaches disk. */
        this.logger.write(stream === 'stderr' ? 'warn' : 'info', 'runtime.stdio', {
            fields: { stream, line: truncateForLog(line) },
        });
    }

    private createReadiness(): RuntimeReadiness {
        let resolve!: () => void;
        let reject!: (error: CaxriError) => void;
        let settled = false;
        const promise = new Promise<void>((resolvePromise, rejectPromise) => {
            resolve = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolvePromise();
            };
            reject = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                rejectPromise(error);
            };
        });
        const timer = setTimeout(() => {
            const failure = new CaxriError(
                'TIMEOUT',
                'Runtime did not become ready within 15 seconds',
            );
            reject(failure);
            this.readiness = undefined;
            this.restartCount = 3;
            this.terminalFailure = failure;
            const child = this.child;
            this.child = undefined;
            child?.kill();
            this.emit('event', {
                event: 'runtime.status',
                payload: { status: 'failed', restartCount: this.restartCount },
            } satisfies RuntimeEvent);
        }, RUNTIME_READY_TIMEOUT_MS);
        return { promise, reject, resolve };
    }

    private onMessage(raw: unknown): void {
        let message: RuntimeMessage;
        try {
            message = parseRuntimeMessage(raw);
        } catch {
            const id =
                typeof raw === 'object' &&
                raw !== null &&
                typeof Reflect.get(raw, 'id') === 'string'
                    ? (Reflect.get(raw, 'id') as string)
                    : undefined;
            const pending = id ? this.pending.get(id) : undefined;
            if (pending && id) {
                clearTimeout(pending.timer);
                this.pending.delete(id);
                pending.reject(new CaxriError('INTERNAL', 'Runtime returned an invalid message'));
            }
            /** Never log the rejected payload because it may contain terminal output or secrets. */
            this.logger.write('error', 'runtime.message_invalid', {
                fields: { correlatedRequest: Boolean(pending) },
            });
            return;
        }
        if ('event' in message) {
            if (message.event === 'runtime.status' && message.payload.status === 'ready') {
                this.readiness?.resolve();
                this.readiness = undefined;
                this.terminalFailure = undefined;
                if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
                this.stabilityTimer = setTimeout(() => {
                    this.restartCount = 0;
                    this.stabilityTimer = undefined;
                }, RUNTIME_STABILITY_WINDOW_MS);
                this.stabilityTimer.unref();
            }
            this.emit('event', message);
            return;
        }
        const response = message;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        /** Rebuilding the error preserves the Runtime's classification through Main to the Renderer. */
        if (!response.ok) {
            pending.reject(fromWireError(response.error));
            return;
        }
        try {
            pending.resolve(parseRuntimeResult(pending.method, response.result));
        } catch (error) {
            const failure =
                error instanceof CaxriError
                    ? error
                    : new CaxriError('INTERNAL', 'Runtime returned an invalid result');
            this.logger.write('error', 'runtime.result_invalid', {
                fields: { method: pending.method, code: failure.code },
            });
            pending.reject(failure);
        }
    }

    private onExit(code: number): void {
        if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
        this.stabilityTimer = undefined;
        this.child = undefined;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new CaxriError('UNAVAILABLE', `Runtime exited with code ${code}`));
        }
        this.pending.clear();
        if (this.intentionalStop || this.terminalFailure) return;
        if (this.restartCount >= 3) {
            const failure = new CaxriError(
                'UNAVAILABLE',
                'Runtime failed after 3 restart attempts',
            );
            this.terminalFailure = failure;
            this.readiness?.reject(failure);
            this.readiness = undefined;
            this.emit('event', {
                event: 'runtime.status',
                payload: { status: 'failed', restartCount: this.restartCount },
            } satisfies RuntimeEvent);
            return;
        }
        this.restartCount += 1;
        this.emit('event', {
            event: 'runtime.status',
            payload: { status: 'restarting', restartCount: this.restartCount },
        } satisfies RuntimeEvent);
        /**
         * `pendingRestart` is fulfilled by the timer below, once the backoff delay has actually
         * elapsed. `start()` returns this same promise to any caller that arrives during the wait
         * (see the guard at its top), so a Renderer request cannot trigger an early fork; it just
         * observes the outcome of the one restart the timer performs.
         */
        const pendingRestart = new Promise<void>((resolve, reject) => {
            setTimeout(
                () => {
                    this.pendingRestart = undefined;
                    this.start().then(resolve, (error: unknown) => {
                        if (!this.intentionalStop)
                            this.logger.write('error', 'runtime.error', {
                                fields: {
                                    error: error instanceof Error ? error.message : String(error),
                                },
                            });
                        reject(error instanceof Error ? error : new Error(String(error)));
                    });
                },
                Math.min(250 * 2 ** (this.restartCount - 1), 2_000),
            );
        });
        /** Bookkeeping-only handler: a caller that never awaits `pendingRestart` must not trigger an unhandled rejection. */
        pendingRestart.catch(() => undefined);
        this.pendingRestart = pendingRestart;
    }

    /** Typed entry point for Main's own Runtime calls; the method table supplies params and result. */
    request<M extends RuntimeMethod>(
        method: M,
        ...args: RuntimeParamsArg<M>
    ): Promise<RuntimeMethodResult<M>> {
        const [params, timeoutMs] = args;
        return this.send(method, params, timeoutMs) as Promise<RuntimeMethodResult<M>>;
    }

    /**
     * Forwards an already validated Renderer request whose method is only known as a union, where
     * TypeScript cannot correlate the method literal with its params type.
     */
    forward(method: RuntimeMethod, params: unknown, timeoutMs?: number): Promise<unknown> {
        return this.send(method, params, timeoutMs);
    }

    private async send(
        method: RuntimeMethod,
        params: unknown = {},
        timeoutMs = 20_000,
    ): Promise<unknown> {
        await this.start();
        const child = this.child;
        if (!child) throw new CaxriError('UNAVAILABLE', 'Runtime is unavailable');
        const id = randomUUID();
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CaxriError('TIMEOUT', `Runtime request timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { method, resolve, reject, timer });
            child.postMessage({ id, method, params });
        });
    }

    async shutdown(): Promise<void> {
        this.intentionalStop = true;
        if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
        this.stabilityTimer = undefined;
        this.readiness?.reject(
            new CaxriError('UNAVAILABLE', 'Runtime stopped before becoming ready'),
        );
        this.readiness = undefined;
        const child = this.child;
        if (!child) return;
        try {
            await this.request('runtime.shutdown', {}, 5_000);
        } catch {
            // The process may exit after completing shutdown before its reply is observed.
        } finally {
            child.kill();
            this.child = undefined;
        }
    }
}
