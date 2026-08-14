import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { CaxriError, fromWireError } from '../shared/ipc/errors';
import { toWireError } from '../shared/ipc/errors';
import {
    runtimeHostControlRequestSchema,
    type RuntimeHostControlRequest,
} from '../shared/ipc/agent-endpoint-control';
import type { RuntimeEvent } from '../shared/ipc/events';
import type { RuntimeMethod, RuntimeMethodResult, RuntimeParamsArg } from '../shared/ipc/methods';
import { isNonExpiringRuntimeMethod } from '../shared/ipc/request-lifetime';
import {
    parseRuntimeMessage,
    parseRuntimeResult,
    type RuntimeMessage,
} from '../shared/ipc/transport';
import type { StructuredLogger } from '../shared/node/logger';
import { safeProcessEnvironment } from '../shared/node/process-environment';

interface PendingRequest {
    method: RuntimeMethod;
    reject(error: CaxriError): void;
    resolve(value: unknown): void;
    timer?: NodeJS.Timeout;
}

interface RuntimeReadiness {
    promise: Promise<void>;
    reject(error: CaxriError): void;
    resolve(): void;
}

export interface HostRuntimeSupervisorOptions {
    agentEndpointControl?(request: RuntimeHostControlRequest): unknown;
    agentHooksPath?: string;
    appVersion: string;
    cliPath?: string;
    commit: string;
    executable?: string;
    extraEnvironment?: NodeJS.ProcessEnv;
    logDirectory: string;
    logger: StructuredLogger;
    runtimePath: string;
    userDataPath: string;
}

type ForkRuntime = typeof fork;

const RUNTIME_READY_TIMEOUT_MS = 15_000;
const RUNTIME_STABILITY_WINDOW_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
function requestTimeout(method: RuntimeMethod): number | undefined {
    return isNonExpiringRuntimeMethod(method) ? undefined : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Host-owned Runtime lifecycle. The child is Electron's Node mode, preserving native ABI parity. */
export class HostRuntimeSupervisor extends EventEmitter {
    private child?: ChildProcess;
    private intentionalStop = false;
    private pending = new Map<string, PendingRequest>();
    private pendingRestart?: Promise<void>;
    private readiness?: RuntimeReadiness;
    private restartCount = 0;
    private stabilityTimer?: NodeJS.Timeout;
    private terminalFailure?: CaxriError;

    constructor(
        private readonly options: HostRuntimeSupervisorOptions,
        private readonly forkRuntime: ForkRuntime = fork,
    ) {
        super();
    }

    processId(): number | undefined {
        return this.child?.pid;
    }

    start(): Promise<void> {
        if (this.pendingRestart) return this.pendingRestart;
        if (this.child) return this.readiness?.promise ?? Promise.resolve();
        if (this.terminalFailure) return Promise.reject(this.terminalFailure);
        if (this.intentionalStop)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Runtime has been stopped'));
        this.readiness ??= this.createReadiness();
        const readiness = this.readiness;
        let child: ChildProcess;
        try {
            child = this.forkRuntime(this.options.runtimePath, [], {
                execPath: this.options.executable ?? process.execPath,
                env: {
                    ...safeProcessEnvironment(),
                    ...this.options.extraEnvironment,
                    ELECTRON_RUN_AS_NODE: '1',
                    CAXRI_LOG_DIRECTORY: this.options.logDirectory,
                    CAXRI_LOG_LEVEL: 'info',
                    CAXRI_USER_DATA_PATH: this.options.userDataPath,
                    CAXRI_APP_VERSION: this.options.appVersion,
                    CAXRI_GIT_COMMIT: this.options.commit,
                    ...(this.options.cliPath ? { CAXRI_CLI_PATH: this.options.cliPath } : {}),
                    ...(this.options.agentHooksPath
                        ? { CAXRI_AGENT_HOOKS_PATH: this.options.agentHooksPath }
                        : {}),
                },
                serialization: 'advanced',
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            });
        } catch (error) {
            const failure = new CaxriError(
                'UNAVAILABLE',
                error instanceof Error ? error.message : 'Runtime failed to start',
            );
            this.failTerminal(failure);
            return readiness.promise;
        }
        this.child = child;
        child.on('message', (message: unknown) => {
            if (this.child === child) this.onMessage(message);
        });
        child.on('exit', (code) => {
            if (this.child === child) this.onExit(code ?? -1);
        });
        child.on('error', (error) => {
            this.options.logger.write('error', 'host.runtime_child_error', {
                fields: { code: 'RUNTIME_CHILD_ERROR', error: error.message },
            });
        });
        return readiness.promise;
    }

    private createReadiness(): RuntimeReadiness {
        let resolve!: () => void;
        let reject!: (error: CaxriError) => void;
        let settled = false;
        const timer = setTimeout(() => {
            const failure = new CaxriError(
                'TIMEOUT',
                'Runtime did not become ready within 15 seconds',
            );
            reject(failure);
            this.terminalFailure = failure;
            const child = this.child;
            this.child = undefined;
            child?.kill();
        }, RUNTIME_READY_TIMEOUT_MS);
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
        return { promise, reject, resolve };
    }

    private onMessage(raw: unknown): void {
        const control = runtimeHostControlRequestSchema.safeParse(raw);
        if (control.success) {
            void this.handleControl(control.data);
            return;
        }
        let message: RuntimeMessage;
        try {
            message = parseRuntimeMessage(raw);
        } catch {
            this.options.logger.write('error', 'host.runtime_message_invalid', {
                fields: { code: 'INVALID_RUNTIME_MESSAGE' },
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
        const pending = this.pending.get(message.id);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (!message.ok) {
            pending.reject(fromWireError(message.error));
            return;
        }
        try {
            pending.resolve(parseRuntimeResult(pending.method, message.result));
        } catch {
            pending.reject(new CaxriError('INTERNAL', 'Runtime returned an invalid result'));
        }
    }

    private async handleControl(request: RuntimeHostControlRequest): Promise<void> {
        const child = this.child;
        if (!child?.connected) return;
        let reply: unknown;
        try {
            if (!this.options.agentEndpointControl)
                throw new CaxriError('UNAVAILABLE', 'Agent Endpoint control is unavailable');
            reply = {
                type: 'host-control.reply',
                id: request.id,
                ok: true,
                result: await this.options.agentEndpointControl(request),
            };
        } catch (error) {
            reply = {
                type: 'host-control.reply',
                id: request.id,
                ok: false,
                error: toWireError(error),
            };
        }
        if (this.child !== child || !child.connected) return;
        try {
            child.send(reply as Parameters<ChildProcess['send']>[0]);
        } catch {
            // Runtime exit owns revocation; no credential is retained in this reply path.
        }
    }

    private onExit(code: number): void {
        if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
        this.stabilityTimer = undefined;
        this.child = undefined;
        this.emit('runtimeExit');
        for (const pending of this.pending.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(new CaxriError('UNAVAILABLE', `Runtime exited with code ${code}`));
        }
        this.pending.clear();
        if (this.intentionalStop || this.terminalFailure) return;
        this.options.logger.write('error', 'host.runtime_exit', {
            fields: { code: 'RUNTIME_EXIT', exitCode: code, restartCount: this.restartCount },
        });
        if (this.restartCount >= 3) {
            this.failTerminal(
                new CaxriError('UNAVAILABLE', 'Runtime failed after 3 restart attempts'),
            );
            return;
        }
        this.restartCount += 1;
        this.emit('event', {
            event: 'runtime.status',
            payload: { status: 'restarting', restartCount: this.restartCount },
        } satisfies RuntimeEvent);
        const pendingRestart = new Promise<void>((resolve, reject) => {
            setTimeout(
                () => {
                    this.pendingRestart = undefined;
                    this.start().then(resolve, reject);
                },
                Math.min(250 * 2 ** (this.restartCount - 1), 2_000),
            );
        });
        pendingRestart.catch(() => undefined);
        this.pendingRestart = pendingRestart;
    }

    private failTerminal(failure: CaxriError): void {
        this.terminalFailure = failure;
        this.readiness?.reject(failure);
        this.readiness = undefined;
        this.emit('event', {
            event: 'runtime.status',
            payload: { status: 'failed', restartCount: this.restartCount },
        } satisfies RuntimeEvent);
    }

    request<M extends RuntimeMethod>(
        method: M,
        ...args: RuntimeParamsArg<M>
    ): Promise<RuntimeMethodResult<M>> {
        const [params, timeoutMs] = args;
        return this.send(method, params, timeoutMs) as Promise<RuntimeMethodResult<M>>;
    }

    forward(method: RuntimeMethod, params: unknown, timeoutMs?: number): Promise<unknown> {
        return this.send(method, params, timeoutMs);
    }

    private async send(
        method: RuntimeMethod,
        params: unknown = {},
        timeoutMs = requestTimeout(method),
    ): Promise<unknown> {
        await this.start();
        const child = this.child;
        if (!child?.connected) throw new CaxriError('UNAVAILABLE', 'Runtime is unavailable');
        const id = randomUUID();
        return new Promise<unknown>((resolve, reject) => {
            const timer =
                timeoutMs === undefined
                    ? undefined
                    : setTimeout(() => {
                          this.pending.delete(id);
                          reject(new CaxriError('TIMEOUT', `Runtime request timed out: ${method}`));
                      }, timeoutMs);
            this.pending.set(id, { method, resolve, reject, timer });
            try {
                child.send({ id, method, params }, (error) => {
                    if (!error || !this.pending.delete(id)) return;
                    if (timer) clearTimeout(timer);
                    reject(new CaxriError('UNAVAILABLE', 'Runtime IPC channel is unavailable'));
                });
            } catch {
                this.pending.delete(id);
                if (timer) clearTimeout(timer);
                reject(new CaxriError('UNAVAILABLE', 'Runtime IPC channel is unavailable'));
            }
        });
    }

    async shutdown(): Promise<void> {
        this.intentionalStop = true;
        if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
        this.stabilityTimer = undefined;
        this.readiness?.reject(new CaxriError('UNAVAILABLE', 'Runtime stopped before readiness'));
        this.readiness = undefined;
        const child = this.child;
        if (!child) return;
        try {
            await this.request('runtime.shutdown', {}, 5_000);
        } catch {
            // The child may exit after completing shutdown before its reply is delivered.
        } finally {
            child.kill();
            this.child = undefined;
        }
    }
}
