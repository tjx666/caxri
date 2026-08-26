import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type {
    RuntimeEvent,
    RuntimeHostControlRequest,
    RuntimeMessage,
    RuntimeMethod,
    RuntimeMethodParams as RuntimeMethodParameters,
    RuntimeMethodResult,
    RuntimeParamsArg as RuntimeParametersArgument,
    RuntimeWorkbenchContext,
} from '@caxri/protocol';
import {
    CaxriError,
    fromWireError,
    isNonExpiringRuntimeMethod,
    parseRuntimeMessage,
    parseRuntimeResult,
    runtimeCancelRequestSchema,
    runtimeHostControlRequestSchema,
    toWireError,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, safeProcessEnvironment } from '@caxri/system';

interface PendingRequest {
    abortCleanup?: () => void;
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

/**
 * Host-owned Runtime lifecycle. The child uses the artifact's pinned runtime and native ABI.
 */
export class HostRuntimeSupervisor extends EventTarget {
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

    private createReadiness(): RuntimeReadiness {
        let resolveReadiness!: () => void;
        let rejectReadiness!: (error: CaxriError) => void;
        let isSettled = false;
        const timer = setTimeout(() => {
            const failure = new CaxriError(
                'TIMEOUT',
                'Runtime did not become ready within 15 seconds',
            );
            rejectReadiness(failure);
            this.terminalFailure = failure;
            const child = this.child;
            this.child = undefined;
            child?.kill();
        }, RUNTIME_READY_TIMEOUT_MS);
        const promise = new Promise<void>((resolve, reject) => {
            resolveReadiness = () => {
                if (isSettled) return;
                isSettled = true;
                clearTimeout(timer);
                resolve();
            };
            rejectReadiness = (error) => {
                if (isSettled) return;
                isSettled = true;
                clearTimeout(timer);
                reject(error);
            };
        });
        return { promise, reject: rejectReadiness, resolve: resolveReadiness };
    }

    private onMessage(raw: unknown): void {
        const control = runtimeHostControlRequestSchema.safeParse(raw);
        if (control.success) {
            // `onMessage` is a synchronous 'message' listener; control replies are internally
            // try/caught, so this is deliberately fire-and-forget rather than awaited.
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
            this.handleControl(control.data).catch(() => {});
            return;
        }
        let message: RuntimeMessage;
        try {
            message = parseRuntimeMessage(raw);
        } catch {
            this.options.logger.write('error', logEventCatalog.host.runtimeMessageInvalid, {
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
            this.dispatchEvent(new CustomEvent<RuntimeEvent>('event', { detail: message }));
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        pending.abortCleanup?.();
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
        // `connected` can flip to false while `agentEndpointControl` above is awaited; TS narrows
        // it from the `!child?.connected` guard at entry and does not account for that async mutation.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- connected can change during the preceding await
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
        this.dispatchEvent(new Event('runtimeExit'));
        for (const pending of this.pending.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.abortCleanup?.();
            pending.reject(new CaxriError('UNAVAILABLE', `Runtime exited with code ${code}`));
        }
        this.pending.clear();
        if (this.intentionalStop || this.terminalFailure) return;
        this.options.logger.write('error', logEventCatalog.host.runtimeExit, {
            fields: { code: 'RUNTIME_EXIT', exitCode: code, restartCount: this.restartCount },
        });
        if (this.restartCount >= 3) {
            this.failTerminal(
                new CaxriError('UNAVAILABLE', 'Runtime failed after 3 restart attempts'),
            );
            return;
        }
        this.restartCount += 1;
        this.dispatchEvent(
            new CustomEvent<RuntimeEvent>('event', {
                detail: {
                    event: 'runtime.status',
                    payload: { status: 'restarting', restartCount: this.restartCount },
                },
            }),
        );
        const pendingRestart = new Promise<void>((resolve) => {
            setTimeout(
                () => {
                    this.pendingRestart = undefined;
                    resolve(this.start());
                },
                Math.min(250 * 2 ** (this.restartCount - 1), 2_000),
            );
        });
        // `onExit` is a synchronous 'exit' listener; a failed restart already surfaces through
        // `start()`'s next caller, so this is deliberately fire-and-forget here.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        pendingRestart.catch(() => {});
        this.pendingRestart = pendingRestart;
    }

    private failTerminal(failure: CaxriError): void {
        this.terminalFailure = failure;
        this.readiness?.reject(failure);
        this.readiness = undefined;
        this.dispatchEvent(
            new CustomEvent<RuntimeEvent>('event', {
                detail: {
                    event: 'runtime.status',
                    payload: { status: 'failed', restartCount: this.restartCount },
                },
            }),
        );
    }

    private async send(
        method: RuntimeMethod,
        parameters: unknown = {},
        timeoutMs = requestTimeout(method),
        context?: RuntimeWorkbenchContext,
        signal?: AbortSignal,
    ): Promise<unknown> {
        await this.start();
        const child = this.child;
        if (!child?.connected) throw new CaxriError('UNAVAILABLE', 'Runtime is unavailable');
        const id = randomUUID();
        return new Promise<unknown>((resolve, reject) => {
            if (signal?.aborted) {
                reject(new CaxriError('CANCELLED', 'Runtime request was canceled'));
                return;
            }
            const timer =
                timeoutMs === undefined
                    ? undefined
                    : setTimeout(() => {
                          this.cancelRequest(
                              id,
                              new CaxriError('TIMEOUT', `Runtime request timed out: ${method}`),
                          );
                      }, timeoutMs);
            let onAbort = (): void => {};
            const pending: PendingRequest = {
                method,
                resolve,
                reject,
                timer,
                abortCleanup: signal
                    ? () => signal.removeEventListener('abort', onAbort)
                    : undefined,
            };
            onAbort = () => this.cancelRequest(id);
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            this.pending.set(id, pending);
            try {
                child.send(
                    { id, method, params: parameters, ...(context && { context }) },
                    (error) => {
                        if (!error || !this.pending.delete(id)) return;
                        if (timer) clearTimeout(timer);
                        pending.abortCleanup?.();
                        reject(new CaxriError('UNAVAILABLE', 'Runtime IPC channel is unavailable'));
                    },
                );
            } catch {
                this.pending.delete(id);
                if (timer) clearTimeout(timer);
                pending.abortCleanup?.();
                reject(new CaxriError('UNAVAILABLE', 'Runtime IPC channel is unavailable'));
            }
        });
    }

    /**
     * Sends an out-of-band cancel frame and settles the Host-side waiter immediately.
     */
    cancelRequest(
        requestId: string,
        reason = new CaxriError('CANCELLED', 'Runtime request was canceled'),
    ): boolean {
        const pending = this.pending.get(requestId);
        if (!pending) return false;
        this.pending.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        pending.abortCleanup?.();
        const child = this.child;
        if (child?.connected) {
            try {
                child.send(runtimeCancelRequestSchema.parse({ type: 'cancel', id: requestId }));
            } catch {
                // The original cancellation still settles locally if the child exits during the frame send.
            }
        }
        pending.reject(reason);
        return true;
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
                    ...(this.options.cliPath && { CAXRI_CLI_PATH: this.options.cliPath }),
                    ...(this.options.agentHooksPath && {
                        CAXRI_AGENT_HOOKS_PATH: this.options.agentHooksPath,
                    }),
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
            this.options.logger.write('error', logEventCatalog.host.runtimeChildError, {
                fields: { code: 'RUNTIME_CHILD_ERROR', error: error.message },
            });
        });
        return readiness.promise;
    }

    /**
     * Subscribes to Runtime protocol events; returns an unsubscribe function.
     */
    onEvent(listener: (event: RuntimeEvent) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<RuntimeEvent>).detail);
        this.addEventListener('event', handler);
        return () => this.removeEventListener('event', handler);
    }

    /**
     * Subscribes to Runtime child-process exit; returns an unsubscribe function.
     */
    onRuntimeExit(listener: () => void): () => void {
        this.addEventListener('runtimeExit', listener);
        return () => this.removeEventListener('runtimeExit', listener);
    }

    request<M extends RuntimeMethod>(
        method: M,
        ...arguments_: RuntimeParametersArgument<M>
    ): Promise<RuntimeMethodResult<M>> {
        const [parameters, timeoutMs] = arguments_;
        return this.send(method, parameters, timeoutMs) as Promise<RuntimeMethodResult<M>>;
    }

    requestWithSignal<M extends RuntimeMethod>(
        method: M,
        parameters: RuntimeMethodParameters<M>,
        signal: AbortSignal,
        timeoutMs = requestTimeout(method),
    ): Promise<RuntimeMethodResult<M>> {
        return this.send(method, parameters, timeoutMs, undefined, signal) as Promise<
            RuntimeMethodResult<M>
        >;
    }

    /**
     * Executes a public Extension workspace operation only if the Runtime still has the Host-attested Workbench Root
     * selected for that Session. The context lives in the trusted Host-to-Runtime envelope, never in extension input.
     */
    requestInWorkbenchContext<M extends RuntimeMethod>(
        method: M,
        parameters: RuntimeMethodParameters<M>,
        context: RuntimeWorkbenchContext,
        timeoutMs?: number,
        signal?: AbortSignal,
    ): Promise<RuntimeMethodResult<M>> {
        return this.send(
            method,
            parameters,
            timeoutMs ?? requestTimeout(method),
            context,
            signal,
        ) as Promise<RuntimeMethodResult<M>>;
    }

    forward(
        method: RuntimeMethod,
        parameters: unknown,
        timeoutMs?: number,
        signal?: AbortSignal,
    ): Promise<unknown> {
        return this.send(method, parameters, timeoutMs, undefined, signal);
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
