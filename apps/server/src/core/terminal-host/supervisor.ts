import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';

import type { CaxriErrorCode, TerminalSnapshot } from '@caxri/protocol';
import { CaxriError, errorCodes } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, safeProcessEnvironment } from '@caxri/system';

import type {
    TerminalHostMessage,
    TerminalHostRequest,
    TerminalHostRequestEnvelope,
    TerminalHostScope,
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
    buildId: string;
    commit: string;
    executable?: string;
    forkProcess?: typeof fork;
    logger: StructuredLogger;
    outputFlushMs?: number;
    serverId: string;
    terminalHostPath: string;
    userDataPath: string;
}

const READY_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_REQUESTS = 256;

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
            return 5_000;
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

    private rejectPending(message: string): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.cleanup?.();
            pending.reject(new CaxriError('UNAVAILABLE', message));
        }
        this.pending.clear();
    }

    private async terminate(owned: OwnedChild): Promise<void> {
        const { child } = owned;
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        const forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        forceTimer.unref();
        await once(child, 'exit');
        clearTimeout(forceTimer);
    }

    private isExpectedReady(
        message: Extract<TerminalHostMessage, { event: 'host.ready' }>,
    ): boolean {
        return (
            message.serverId === this.options.serverId &&
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
        this.options.logger.write(
            this.intentionalStop ? 'info' : 'error',
            logEventCatalog.terminalHost.exited,
            { fields: { code, signal: signal ?? null } },
        );
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
            execPath: this.options.executable ?? process.execPath,
            env: {
                ...safeProcessEnvironment(),
                CAXRI_APP_VERSION: this.options.appVersion,
                CAXRI_BUILD_ID: this.options.buildId,
                CAXRI_GIT_COMMIT: this.options.commit,
                CAXRI_SERVER_ID: this.options.serverId,
                CAXRI_TERMINAL_HOST_CREDENTIAL: credential,
                CAXRI_USER_DATA_PATH: this.options.userDataPath,
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
            fields: { pid: child.pid ?? -1, serverId: this.options.serverId },
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
    ): Promise<unknown> {
        if (this.pending.size >= MAX_CONCURRENT_REQUESTS)
            throw new CaxriError('CAPACITY', 'Terminal Host request capacity exceeded');
        if (this.owned !== owned || !owned.child.connected)
            throw new CaxriError('UNAVAILABLE', 'Terminal Host is unavailable');
        const id = randomUUID();
        const envelope: TerminalHostRequestEnvelope = {
            type: 'request',
            protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
            id,
            credential: owned.credential,
            serverId: this.options.serverId,
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
            const timer = setTimeout(() => {
                const pending = this.pending.get(id);
                if (!pending) return;
                this.pending.delete(id);
                pending.cleanup?.();
                this.options.logger.write('warn', logEventCatalog.terminalHost.requestTimeout, {
                    correlationId: id,
                    fields: { method: request.method },
                });
                reject(
                    new CaxriError('TIMEOUT', `Terminal Host request timed out: ${request.method}`),
                );
            }, requestTimeout(request));
            timer.unref();
            if (signal) {
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

    processId(): number | undefined {
        return this.owned?.child.pid;
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

    async shutdown(): Promise<TerminalSnapshot[]> {
        this.intentionalStop = true;
        this.state = 'stopped';
        this.startedAt = undefined;
        const owned = this.owned;
        if (!owned) return [];
        let snapshots: TerminalSnapshot[] = [];
        try {
            const result = (await this.sendRequest(
                owned,
                { method: 'host.shutdown', params: {} },
                { scope: 'server', capability: 'host.lifecycle' },
            )) as { snapshots: TerminalSnapshot[]; stopped: true };
            snapshots = result.snapshots;
        } catch {
            // The owned child is force-terminated below if graceful snapshot capture failed.
        }
        if (this.owned === owned) {
            this.owned = undefined;
            this.startup = undefined;
            this.rejectPending('Terminal Host is stopping');
            await this.terminate(owned);
        }
        return snapshots;
    }
}
