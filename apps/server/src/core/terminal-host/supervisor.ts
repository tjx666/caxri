import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';

import type { CaxriErrorCode, TerminalSnapshot } from '@caxri/protocol';
import {
    CaxriError,
    errorCodes,
    errorMessage,
    inspectExecArgv,
    logLevelEnvironment,
} from '@caxri/protocol';
import type { E2EAgentPolicy, StructuredLogger } from '@caxri/system';
import {
    currentObservationContext,
    e2eAgentPolicyEnvironment,
    logEventCatalog,
    mergeObservationContext,
    safeProcessEnvironment,
} from '@caxri/system';

import type {
    TerminalHostMessage,
    TerminalHostRequest,
    TerminalHostRequestEnvelope,
    TerminalHostScope,
    TerminalShutdownFailure,
} from '../../terminal-host/protocol';
import {
    isBoundedTerminalHostMessage,
    isTerminalHostResult,
    TERMINAL_HOST_PROTOCOL_VERSION,
    terminalHostMessageSchema,
    terminalHostRequestEnvelopeSchema,
} from '../../terminal-host/protocol';

interface PendingRequest {
    cleanup?(): void;
    method: TerminalHostRequest['method'];
    reject(error: Error): void;
    resolve(value: unknown): void;
    timer?: NodeJS.Timeout;
}

interface OwnedChild {
    child: ChildProcess;
    credential: string;
}

export interface TerminalHostSupervisorOptions {
    appVersion: string;
    bootId: string;
    buildId: string;
    commit: string;
    e2eAgentPolicy?: E2EAgentPolicy;
    executable?: string;
    forkProcess?: typeof fork;
    logger: StructuredLogger;
    outputFlushMs?: number;
    terminalHostPath: string;
    userDataPath: string;
}

const READY_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_REQUESTS = 256;
/**
 * Terminal input and output already use explicit byte bounds, so the isolated Host does not need the runtime's larger
 * adaptive young generation. This is not a heap ceiling: long-lived screen and scrollback state can still promote to
 * the old generation while short-lived private envelopes are collected with a smaller steady RSS footprint.
 */
const TERMINAL_HOST_EXEC_ARGV = ['--max-semi-space-size=8'];

const MIN_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_PER_TERMINAL_MS = 1_000;

/**
 * `host.shutdown` must let the Terminal Host cross the parser barrier for every live Terminal before Server Core gives
 * up and force-terminates the child. A fixed timeout starves a Host holding many live Terminals: the budget instead
 * scales with how many final snapshots it actually has to capture, capped so a runaway Terminal count cannot delay
 * application shutdown indefinitely.
 */
function shutdownTimeoutMs(liveTerminalCount: number): number {
    return Math.min(
        MAX_SHUTDOWN_TIMEOUT_MS,
        MIN_SHUTDOWN_TIMEOUT_MS + SHUTDOWN_TIMEOUT_PER_TERMINAL_MS * liveTerminalCount,
    );
}

function requestTimeout(request: TerminalHostRequest): number {
    switch (request.method) {
        case 'terminal.input':
        case 'terminal.resize':
        case 'terminal.detach':
        case 'terminal.signal':
            return 2_000;
        case 'terminal.waitForAttachedSize':
            return request.params.timeoutMs + 1_000;
        case 'host.shutdown':
            return MIN_SHUTDOWN_TIMEOUT_MS;
        default:
            return DEFAULT_REQUEST_TIMEOUT_MS;
    }
}

function replyError(error: { code: string; message: string }): Error {
    if (errorCodes.includes(error.code as CaxriErrorCode))
        return new CaxriError(error.code as CaxriErrorCode, error.message);
    return Object.assign(new Error(error.message), { code: error.code });
}

/**
 * Core-owned lifecycle for the Terminal Host child. A child exit fences every pending operation and live identity; the
 * next request may start an empty Host, but PTYs are never adopted across children or Server Core generations.
 */
export class TerminalHostSupervisor extends EventTarget {
    /**
     * Set by `markCoreStopping()` when Server Core's own `stop()` begins, before the graceful `host.shutdown` request
     * necessarily reaches this Host. Distinguishes an unexpected crash from an OS-initiated signal (e.g. the whole
     * process tree receiving SIGKILL during an app update) that reaches the Host outside the normal `shutdown()` path:
     * see `handleExit`.
     */
    private coreStopping = false;
    private intentionalStop = false;
    private lastExit?: { at: number; code: number; signal: NodeJS.Signals | null };
    private launchCount = 0;
    private owned?: OwnedChild;
    private readonly pending = new Map<string, PendingRequest>();
    private readiness?: Promise<void>;
    private rejectReady?: (error: Error) => void;
    private resolveReady?: () => void;
    private startedAt?: number;
    private state: 'idle' | 'starting' | 'ready' | 'failed' | 'stopped' = 'idle';
    private startup?: Promise<void>;

    constructor(private readonly options: TerminalHostSupervisorOptions) {
        super();
    }

    private rejectPending(message: string, code: CaxriErrorCode = 'UNAVAILABLE'): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.cleanup?.();
            pending.reject(new CaxriError(code, message));
        }
        this.pending.clear();
    }

    /**
     * `graceMs` defaults to the unscaled `host.shutdown` floor because most callers (e.g. a failed startup) never
     * attempted a snapshot capture. `shutdown()` passes the same scaled budget it gave `host.shutdown`, so a Host still
     * legitimately capturing many Terminals' snapshots is not SIGKILLed out from under a slow-but-progressing capture
     * the instant the graceful request round trip ends.
     */
    private async terminate(owned: OwnedChild, graceMs = MIN_SHUTDOWN_TIMEOUT_MS): Promise<void> {
        const { child } = owned;
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        const forceTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
        forceTimer.unref();
        await once(child, 'exit');
        clearTimeout(forceTimer);
    }

    private isExpectedReady(
        message: Extract<TerminalHostMessage, { event: 'host.ready' }>,
    ): boolean {
        return (
            message.bootId === this.options.bootId &&
            message.appVersion === this.options.appVersion &&
            message.buildId === this.options.buildId &&
            message.commit === this.options.commit
        );
    }

    private onMessage(owned: OwnedChild, value: unknown): void {
        if (
            !isBoundedTerminalHostMessage(value) ||
            !terminalHostMessageSchema.safeParse(value).success
        ) {
            this.options.logger.write('error', logEventCatalog.terminalHost.invalidMessage);
            owned.child.kill();
            return;
        }
        const message = value as TerminalHostMessage;
        if (message.type === 'event') {
            if (message.event === 'host.ready') {
                if (!this.resolveReady || !this.isExpectedReady(message)) {
                    this.options.logger.write('error', logEventCatalog.terminalHost.invalidMessage);
                    owned.child.kill();
                    return;
                }
                this.resolveReady();
                this.resolveReady = undefined;
                this.rejectReady = undefined;
                return;
            }
            this.dispatchEvent(new CustomEvent('event', { detail: message }));
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.cleanup?.();
        this.pending.delete(message.id);
        if (message.ok && !isTerminalHostResult(pending.method, message.result)) {
            pending.reject(
                new CaxriError('UNAVAILABLE', 'Terminal Host returned an invalid result'),
            );
            this.options.logger.write('error', logEventCatalog.terminalHost.invalidMessage, {
                correlationId: message.id,
                fields: { method: pending.method },
            });
            owned.child.kill();
        } else if (message.ok) pending.resolve(message.result);
        else pending.reject(replyError(message.error));
    }

    private handleExit(owned: OwnedChild, code: number, signal: NodeJS.Signals | null): void {
        if (this.owned !== owned) return;
        this.owned = undefined;
        this.readiness = undefined;
        this.startup = undefined;
        this.rejectReady?.(new CaxriError('UNAVAILABLE', 'Terminal Host exited before ready'));
        this.rejectReady = undefined;
        this.resolveReady = undefined;
        this.lastExit = { at: Date.now(), code, signal };
        this.startedAt = undefined;
        this.state = this.intentionalStop ? 'stopped' : 'failed';
        this.rejectPending(`Terminal Host exited with code ${code}`);
        /**
         * A signal-driven exit while Server Core is itself mid-`stop()` is most likely the OS tearing down the whole
         * process tree (e.g. during an app update) rather than a genuine Terminal Host crash: `intentionalStop` only
         * covers the case where this supervisor's own `shutdown()` reached the child first. Demote to 'warn' instead of
         * 'error' so routine app-quit teardown does not read as a production incident.
         */
        const level = this.intentionalStop
            ? 'info'
            : signal && this.coreStopping
              ? 'warn'
              : 'error';
        this.options.logger.write(level, logEventCatalog.terminalHost.exited, {
            fields: {
                code,
                signal: signal ?? null,
                ...(level === 'warn' && { source: 'core-stopping' }),
            },
        });
        if (!this.intentionalStop)
            this.dispatchEvent(new CustomEvent('exit', { detail: { code, signal } }));
    }

    private async startOnce(): Promise<void> {
        if (this.intentionalStop) throw new CaxriError('UNAVAILABLE', 'Terminal Host is stopped');
        this.state = 'starting';
        this.startedAt = undefined;
        this.launchCount += 1;
        const credential = randomBytes(32).toString('hex');
        this.readiness = new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new CaxriError('TIMEOUT', 'Terminal Host did not become ready')),
                READY_TIMEOUT_MS,
            );
            this.resolveReady = () => {
                clearTimeout(timeout);
                resolve();
            };
            this.rejectReady = (error) => {
                clearTimeout(timeout);
                reject(error);
            };
        });
        const child = (this.options.forkProcess ?? fork)(this.options.terminalHostPath, [], {
            execArgv: [
                ...TERMINAL_HOST_EXEC_ARGV,
                ...inspectExecArgv('terminal-host', process.env),
            ],
            execPath: this.options.executable ?? process.execPath,
            env: {
                ...safeProcessEnvironment(),
                ...logLevelEnvironment(process.env),
                CAXRI_APP_VERSION: this.options.appVersion,
                CAXRI_BUILD_ID: this.options.buildId,
                CAXRI_GIT_COMMIT: this.options.commit,
                CAXRI_SERVER_BOOT_ID: this.options.bootId,
                CAXRI_TERMINAL_HOST_CREDENTIAL: credential,
                CAXRI_USER_DATA_PATH: this.options.userDataPath,
                ...e2eAgentPolicyEnvironment(this.options.e2eAgentPolicy),
                ...(this.options.outputFlushMs !== undefined && {
                    CAXRI_E2E: '1',
                    CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS: String(this.options.outputFlushMs),
                }),
            },
            serialization: 'advanced',
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        const owned = { child, credential };
        this.owned = owned;
        child.on('message', (message: unknown) => {
            if (this.owned === owned) this.onMessage(owned, message);
        });
        child.on('exit', (code, signal) => this.handleExit(owned, code ?? -1, signal));
        child.on('error', (error) =>
            this.options.logger.write('error', logEventCatalog.terminalHost.error, {
                fields: { message: error.message },
            }),
        );
        try {
            await this.readiness;
            await this.sendRequest(
                owned,
                {
                    method: 'host.initialize',
                    params: {
                        appVersion: this.options.appVersion,
                        buildId: this.options.buildId,
                        commit: this.options.commit,
                    },
                },
                { scope: 'server', capability: 'host.lifecycle' },
            );
        } catch (error) {
            if (this.owned === owned) {
                this.rejectPending('Terminal Host failed to start');
                await this.terminate(owned);
            }
            throw error;
        }
        this.options.logger.write('info', logEventCatalog.terminalHost.started, {
            fields: { bootId: this.options.bootId, pid: child.pid ?? -1 },
        });
        this.startedAt = Date.now();
        this.state = 'ready';
        this.dispatchEvent(new Event('start'));
    }

    private sendRequest(
        owned: OwnedChild,
        request: TerminalHostRequest,
        scope: TerminalHostScope,
        signal?: AbortSignal,
        timeoutOverrideMs?: number,
    ): Promise<unknown> {
        if (this.pending.size >= MAX_CONCURRENT_REQUESTS)
            throw new CaxriError('CAPACITY', 'Terminal Host request capacity exceeded');
        if (this.owned !== owned || !owned.child.connected)
            throw new CaxriError('UNAVAILABLE', 'Terminal Host is unavailable');
        const id = randomUUID();
        const parentObservation = currentObservationContext();
        const observation = mergeObservationContext(
            parentObservation,
            {
                operationId: id,
                requestId: parentObservation.requestId ?? id,
                traceId: parentObservation.traceId ?? id,
            },
            scope.scope === 'terminal'
                ? { sessionId: scope.sessionId, terminalId: scope.terminalId }
                : undefined,
        );
        const envelope: TerminalHostRequestEnvelope = {
            type: 'request',
            protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
            id,
            observation,
            credential: owned.credential,
            bootId: this.options.bootId,
            scope,
            request,
        };
        const parsedEnvelope = terminalHostRequestEnvelopeSchema.safeParse(envelope);
        if (!parsedEnvelope.success) {
            this.options.logger.write('error', logEventCatalog.terminalHost.invalidMessage, {
                fields: {
                    method: request.method,
                    issues: parsedEnvelope.error.issues
                        .map((issue) => `${issue.path.join('.')}:${issue.code}`)
                        .join(','),
                },
            });
            throw new CaxriError('INTERNAL', 'Terminal Host request failed local validation');
        }
        return new Promise((resolve, reject) => {
            let removeAbortListener: (() => void) | undefined;
            const settleAbort = (): void => {
                const pending = this.pending.get(id);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.pending.delete(id);
                pending.cleanup?.();
                reject(
                    new CaxriError(
                        'CANCELLED',
                        `Terminal Host request cancelled: ${request.method}`,
                    ),
                );
            };
            const timer = setTimeout(
                () => {
                    const pending = this.pending.get(id);
                    if (!pending) return;
                    this.pending.delete(id);
                    pending.cleanup?.();
                    this.options.logger.write('warn', logEventCatalog.terminalHost.requestTimeout, {
                        correlationId: id,
                        context: observation,
                        fields: { method: request.method },
                        failure: {
                            code: 'TIMEOUT',
                            owner: 'terminal-host',
                            phase: 'execute',
                            reason: 'timeout',
                            remediation: 'restart-terminal-host',
                            retryable: true,
                        },
                    });
                    reject(
                        new CaxriError(
                            'TIMEOUT',
                            `Terminal Host request timed out: ${request.method}`,
                        ),
                    );
                },
                timeoutOverrideMs ?? requestTimeout(request),
            );
            timer.unref();
            /**
             * Agent and mobile input become irreversible once sent to the Host. Their signals fence admission before
             * `child.send`; the Host reply decides whether input was accepted after that point.
             */
            if (
                signal &&
                request.method !== 'terminal.agent.input' &&
                request.method !== 'terminal.observer.input'
            ) {
                signal.addEventListener('abort', settleAbort, { once: true });
                removeAbortListener = () => signal.removeEventListener('abort', settleAbort);
            }
            this.pending.set(id, {
                cleanup: removeAbortListener,
                method: request.method,
                reject,
                resolve,
                timer,
            });
            if (signal?.aborted) {
                settleAbort();
                return;
            }
            owned.child.send(envelope, (error) => {
                if (!error) return;
                const pending = this.pending.get(id);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.pending.delete(id);
                pending.cleanup?.();
                reject(new CaxriError('UNAVAILABLE', 'Failed to send Terminal Host request'));
            });
        });
    }

    async start(): Promise<void> {
        if (this.startup) return this.startup;
        this.startup = this.startOnce();
        try {
            await this.startup;
        } catch (error) {
            if (!this.intentionalStop) this.state = 'failed';
            if (!this.owned) this.startup = undefined;
            throw error;
        }
    }

    diagnostics(): {
        state: 'idle' | 'starting' | 'ready' | 'failed' | 'stopped';
        pid?: number;
        startedAt?: number;
        restartCount: number;
        pendingRequestCount: number;
        lastExit?: { at: number; code: number; signal: NodeJS.Signals | null };
    } {
        return {
            state: this.state,
            ...(this.owned?.child.pid !== undefined && { pid: this.owned.child.pid }),
            ...(this.startedAt !== undefined && { startedAt: this.startedAt }),
            restartCount: Math.max(0, this.launchCount - 1),
            pendingRequestCount: this.pending.size,
            ...(this.lastExit && { lastExit: this.lastExit }),
        };
    }

    async request(
        request: TerminalHostRequest,
        scope: TerminalHostScope,
        signal?: AbortSignal,
    ): Promise<unknown> {
        await this.start();
        const owned = this.owned;
        if (!owned) throw new CaxriError('UNAVAILABLE', 'Terminal Host is unavailable');
        return this.sendRequest(owned, request, scope, signal);
    }

    isRunning(): boolean {
        return this.state === 'ready' && this.owned !== undefined;
    }

    processId(): number | undefined {
        return this.owned?.child.pid;
    }

    /**
     * Called from `server-core.ts stop()` before the graceful `host.shutdown` request necessarily arrives, so an OS
     * signal that reaches this child first (see `handleExit`) is recognized as expected teardown, not a crash.
     */
    markCoreStopping(): void {
        this.coreStopping = true;
    }

    onEvent(
        listener: (
            event: Exclude<
                Extract<TerminalHostMessage, { type: 'event' }>,
                { event: 'host.ready' }
            >,
        ) => void,
    ): () => void {
        const handler = (event: Event): void =>
            listener(
                (
                    event as CustomEvent<
                        Exclude<
                            Extract<TerminalHostMessage, { type: 'event' }>,
                            { event: 'host.ready' }
                        >
                    >
                ).detail,
            );
        this.addEventListener('event', handler);
        return () => this.removeEventListener('event', handler);
    }

    onExit(listener: (event: { code: number; signal: NodeJS.Signals | null }) => void): () => void {
        const handler = (event: Event): void =>
            listener(
                (event as CustomEvent<{ code: number; signal: NodeJS.Signals | null }>).detail,
            );
        this.addEventListener('exit', handler);
        return () => this.removeEventListener('exit', handler);
    }

    /**
     * `liveTerminalCount` scales both the `host.shutdown` request timeout and the subsequent SIGTERM→SIGKILL grace (see
     * `shutdownTimeoutMs`), since a Host holding many live Terminals genuinely needs more wall-clock time to cross
     * every parser barrier. A timed-out or otherwise failed request is logged as `shutdownFailed` instead of silently
     * swallowed, so a lost shutdown capture is diagnosable from the Server Core log alone.
     */
    async shutdown(liveTerminalCount = 0): Promise<{
        failures: TerminalShutdownFailure[];
        snapshots: TerminalSnapshot[];
    }> {
        this.intentionalStop = true;
        this.state = 'stopped';
        this.startedAt = undefined;
        const owned = this.owned;
        if (!owned) return { failures: [], snapshots: [] };
        const timeoutMs = shutdownTimeoutMs(liveTerminalCount);
        let snapshots: TerminalSnapshot[] = [];
        let failures: TerminalShutdownFailure[] = [];
        try {
            const result = (await this.sendRequest(
                owned,
                { method: 'host.shutdown', params: {} },
                { scope: 'server', capability: 'host.lifecycle' },
                undefined,
                timeoutMs,
            )) as {
                snapshots: TerminalSnapshot[];
                stopped: true;
                failures?: TerminalShutdownFailure[];
            };
            snapshots = result.snapshots;
            failures = result.failures ?? [];
        } catch (error) {
            this.options.logger.write('warn', logEventCatalog.terminalHost.shutdownFailed, {
                fields: {
                    error: errorMessage(error, 'unknown'),
                    expectedSnapshotCount: liveTerminalCount,
                    timeoutMs,
                },
            });
        }
        if (this.owned === owned) {
            this.owned = undefined;
            this.startup = undefined;
            /**
             * Intentional shutdown cancels stale reads; reserving UNAVAILABLE for Host loss keeps it actionable.
             */
            this.rejectPending('Terminal Host is stopping', 'CANCELLED');
            await this.terminate(owned, timeoutMs);
        }
        return { failures, snapshots };
    }
}
