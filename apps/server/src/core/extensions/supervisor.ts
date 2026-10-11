import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { dirname } from 'node:path';
import process from 'node:process';

import {
    inheritedExecArgv,
    inspectExecArgv,
    isNonExpiringViewOperation,
    logLevelEnvironment,
} from '@caxri/protocol';
import type { ExtensionHostProtocolFault, StructuredLogger } from '@caxri/system';
import {
    currentObservationContext,
    logEventCatalog,
    mergeObservationContext,
    resolveExtensionHostProtocolFaults,
    runWithObservationContext,
    safeProcessEnvironment,
} from '@caxri/system';

import type {
    ExtensionHostApiRequest,
    ExtensionHostMessage,
    ExtensionHostRegistration,
    ExtensionHostRequest,
} from '../../extension-host/protocol';
import { logProtocolRejection } from '../../extension-host/protocol-diagnostics';
import {
    extensionHostReplyError,
    isExtensionHostMessage,
    isExtensionHostResult,
} from './host-message-validation';

interface PendingRequest {
    method: ExtensionHostRequest['method'];
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer?: NodeJS.Timeout;
}

export interface ExtensionHostSupervisorOptions {
    appVersion: string;
    bootId: string;
    buildId: string;
    commit: string;
    executable?: string;
    extensionHostPath: string;
    logger: StructuredLogger;
    /**
     * Acceptance-only override for the reproduced protocol-rejection sequence. Production callers omit it so the
     * sequence is resolved from the fail-closed environment gate instead.
     */
    protocolFaults?: ExtensionHostProtocolFault[];
    registrations(): ExtensionHostRegistration[];
    requestApi(request: ExtensionHostApiRequest, signal?: AbortSignal): Promise<unknown>;
    serverId: string;
    userDataPath: string;
}

const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_AUTO_RESTARTS = 5;
const RESTART_STABILITY_MS = 30_000;

function isChildRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
}

function requestTimeout(
    method: ExtensionHostRequest['method'],
    parameters: ExtensionHostRequest['params'],
): number | undefined {
    if (method !== 'viewOperation') return REQUEST_TIMEOUT_MS;
    const operation = (
        parameters as Extract<ExtensionHostRequest, { method: 'viewOperation' }>['params']
    ).operation;
    return isNonExpiringViewOperation(operation) ? undefined : REQUEST_TIMEOUT_MS;
}

function cancellableRequestId(
    method: ExtensionHostRequest['method'],
    parameters: ExtensionHostRequest['params'],
): string | undefined {
    if (method === 'treeChildren')
        return (parameters as Extract<ExtensionHostRequest, { method: 'treeChildren' }>['params'])
            .requestId;
    if (method === 'viewOperation')
        return (parameters as Extract<ExtensionHostRequest, { method: 'viewOperation' }>['params'])
            .requestId;
    return undefined;
}

/**
 * Re-reads mutable child state after an awaited request so replies never target a disconnected child.
 */
function isChildConnected(child: ChildProcess): boolean {
    return child.connected;
}

/**
 * Server Core-owned lifecycle for the shared ESM Extension Host. Domain services and PTYs remain unaffected by this
 * child.
 */
export class ExtensionHostSupervisor extends EventTarget {
    private child?: ChildProcess;
    private intentionalStop = false;
    private pending = new Map<string, PendingRequest>();
    private readonly apiRequests = new Map<string, AbortController>();
    private readiness?: Promise<void>;
    private startup?: Promise<void>;
    private resolveReady?: () => void;
    private rejectReady?: (error: Error) => void;
    private restartCount = 0;
    private restartTimer?: NodeJS.Timeout;
    private restartResetTimer?: NodeJS.Timeout;
    private circuitOpen = false;
    private startAttempts = 0;
    private readonly protocolFaults: ExtensionHostProtocolFault[];
    private corruptNextReplyResult = false;

    constructor(private readonly options: ExtensionHostSupervisorOptions) {
        super();
        this.protocolFaults = options.protocolFaults ?? resolveExtensionHostProtocolFaults();
    }

    private rejectPendingRequests(message: string): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(
                Object.assign(new Error(message), { code: 'EXTENSION_HOST_UNAVAILABLE' }),
            );
        }
        this.pending.clear();
    }

    private async terminateChild(child: ChildProcess): Promise<void> {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        const forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        forceTimer.unref();
        await once(child, 'exit');
        clearTimeout(forceTimer);
    }

    private async waitForGracefulChildExit(child: ChildProcess): Promise<void> {
        if (!isChildRunning(child)) return;
        let graceTimer: NodeJS.Timeout | undefined;
        await Promise.race([
            once(child, 'exit'),
            new Promise<void>((resolve) => {
                graceTimer = setTimeout(resolve, 5_000);
                graceTimer.unref();
            }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
        if (isChildRunning(child)) await this.terminateChild(child);
    }

    private async handleApiRequest(request: ExtensionHostApiRequest): Promise<void> {
        const child = this.child;
        if (!child?.connected) return;
        const controller = new AbortController();
        this.apiRequests.set(request.id, controller);
        try {
            const result = await runWithObservationContext(
                mergeObservationContext(request.observation, {
                    operationId: request.id,
                    requestId: request.observation?.requestId ?? request.id,
                    traceId: request.observation?.traceId ?? request.id,
                }),
                () => this.options.requestApi(request, controller.signal),
            );
            if (child === this.child && isChildConnected(child))
                child.send({ type: 'api-reply', id: request.id, ok: true, result });
        } catch (error) {
            if (child === this.child && isChildConnected(child))
                child.send({
                    type: 'api-reply',
                    id: request.id,
                    ok: false,
                    error: {
                        code:
                            typeof error === 'object' && error !== null && 'code' in error
                                ? String(error.code)
                                : 'CAPABILITY_DENIED',
                        message: error instanceof Error ? error.message : String(error),
                    },
                });
        } finally {
            if (this.apiRequests.get(request.id) === controller)
                this.apiRequests.delete(request.id);
        }
    }

    /**
     * Replaces the next successful reply's payload so the real `reply-result` rejection runs against a real reply.
     * Armed only by an Acceptance fault sequence. `undefined` is the only value every method rejects: `viewOperation`
     * accepts any serializable payload including `null`, so the reason under test would otherwise depend on which
     * request happened to answer first.
     */
    private applyReplyResultFault(message: ExtensionHostMessage): ExtensionHostMessage {
        if (!this.corruptNextReplyResult || message.type !== 'reply' || !message.ok) return message;
        this.corruptNextReplyResult = false;
        return { ...message, result: undefined };
    }

    /**
     * Reproduces one Extension Host protocol rejection for an Acceptance case, consuming the sequence one fault per
     * successful start so each supervised restart surfaces the next reason in the Logs panel.
     *
     * Every fault enters through the same code path the corresponding production failure would take: `parent-envelope`
     * sends a malformed envelope over the live IPC channel and is classified by the Host itself, `child-envelope` hands
     * the supervisor's own message handler a malformed value, and `reply-result` arms the corruption above and drives a
     * real request so a real reply is what fails validation. None of them bypass `logProtocolRejection`, and none carry
     * caller-supplied content into the protocol.
     */
    private injectNextProtocolFault(child: ChildProcess): void {
        const fault = this.protocolFaults.at(0);
        if (fault === undefined) return;
        try {
            this.deliverProtocolFault(fault, child);
        } catch {
            // `sendRequest` throws synchronously on a closed or saturated channel, and this runs outside `startOnce`'s
            // try/catch. Swallow it so an undelivered fault cannot fail an otherwise successful start, disarm the reply
            // corruption so it can never reach an unrelated later reply, and leave the fault queued for the next start.
            this.corruptNextReplyResult = false;
            return;
        }
        this.protocolFaults.shift();
    }

    private deliverProtocolFault(fault: ExtensionHostProtocolFault, child: ChildProcess): void {
        if (fault === 'reply-result') {
            this.corruptNextReplyResult = true;
            // eslint-disable-next-line no-void -- The reply is the subject under test; its rejection is the expected outcome.
            void this.sendRequest('configure', {
                extensions: this.options.registrations(),
            }).catch(() => {});
            return;
        }
        if (fault === 'child-envelope') {
            this.onMessage({ type: 'caxri-acceptance-invalid-envelope' });
            return;
        }
        if (!isChildConnected(child)) throw new Error('Extension Host channel is closed');
        child.send({ type: 'caxri-acceptance-invalid-envelope' });
    }

    private onMessage(value: unknown): void {
        if (!isExtensionHostMessage(value)) {
            logProtocolRejection(this.options.logger, 'child-envelope');
            this.child?.kill();
            return;
        }
        const message = this.applyReplyResultFault(value);
        if (message.type === 'ready') {
            this.resolveReady?.();
            this.resolveReady = undefined;
            this.rejectReady = undefined;
            return;
        }
        if (message.type === 'api-cancel') {
            this.apiRequests.get(message.id)?.abort();
            return;
        }
        if (message.type === 'api-request') {
            // IPC message dispatch is synchronous; the request handler reports its own failure.
            // eslint-disable-next-line unicorn/prefer-await
            this.handleApiRequest(message).catch((error: unknown) =>
                this.options.logger.write('error', logEventCatalog.extensionHost.apiRequestFailed, {
                    fields: { message: error instanceof Error ? error.message : String(error) },
                }),
            );
            return;
        }
        if (message.type === 'event') {
            this.dispatchEvent(new CustomEvent('event', { detail: message }));
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok && !isExtensionHostResult(pending.method, message.result)) {
            pending.reject(
                Object.assign(new Error('Extension Host returned an invalid result'), {
                    code: 'EXTENSION_HOST_UNAVAILABLE',
                }),
            );
            logProtocolRejection(this.options.logger, 'reply-result');
            this.child?.kill();
        } else if (message.ok) pending.resolve(message.result);
        else pending.reject(extensionHostReplyError(message.error));
    }

    /**
     * Settles everything owned by the current child before it is replaced. Both a crash (`handleExit`) and an explicit
     * `restart` must run this: the exit listener is gated on `this.child === child`, so once `restart` detaches the
     * child its exit no longer reaches `handleExit`, and anything left here would hang. Concretely, callers parked on
     * the retired startup would wait for the 15 second ready timeout, because the next start overwrites `resolveReady`,
     * and the retired child's Extension API requests would keep running with no one to reply to.
     */
    private retireChild(reason: string): void {
        for (const controller of this.apiRequests.values()) controller.abort();
        this.apiRequests.clear();
        if (this.restartResetTimer) clearTimeout(this.restartResetTimer);
        this.restartResetTimer = undefined;
        this.child = undefined;
        this.readiness = undefined;
        this.startup = undefined;
        this.rejectReady?.(
            Object.assign(new Error(`${reason} before becoming ready`), {
                code: 'EXTENSION_HOST_UNAVAILABLE',
            }),
        );
        this.rejectReady = undefined;
        this.resolveReady = undefined;
        this.rejectPendingRequests(reason);
        // An armed reply corruption belongs to the generation that armed it. Without this reset an injected
        // `configure` that never answers `ok` would corrupt a healthy Host's reply after the restart.
        this.corruptNextReplyResult = false;
    }

    private handleExit(code: number): void {
        this.retireChild(`Extension Host exited with code ${code}`);
        if (this.intentionalStop) return;
        this.options.logger.write('error', logEventCatalog.extensionHost.exit, {
            fields: { code },
            failure: {
                code: 'EXTENSION_HOST_UNAVAILABLE',
                owner: 'extension-host',
                phase: 'runtime',
                reason: 'extension-host-exited',
                remediation: 'restart-extension-host',
                retryable: true,
            },
        });
        this.dispatchEvent(new CustomEvent('exit', { detail: { code } }));
        this.restartCount += 1;
        if (this.restartCount > MAX_AUTO_RESTARTS) {
            this.circuitOpen = true;
            this.options.logger.write('error', logEventCatalog.extensionHost.restartExhausted, {
                fields: { attempts: this.restartCount - 1 },
            });
            return;
        }
        this.restartTimer = setTimeout(
            // Timer callbacks cannot await the bounded restart attempt.
            () => {
                this.restartTimer = undefined;
                // eslint-disable-next-line unicorn/prefer-await
                this.start().catch((error) =>
                    this.options.logger.write(
                        'error',
                        logEventCatalog.extensionHost.restartFailed,
                        {
                            fields: {
                                message: error instanceof Error ? error.message : String(error),
                            },
                        },
                    ),
                );
            },
            Math.min(250 * 2 ** (this.restartCount - 1), 2_000),
        );
        this.restartTimer.unref();
    }

    private async startOnce(): Promise<void> {
        if (this.intentionalStop) throw new Error('Extension Host has been stopped');
        const startedAt = performance.now();
        const isRestart = this.startAttempts > 0;
        this.startAttempts += 1;
        this.readiness = new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('Extension Host did not become ready within 15 seconds')),
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
        const child = fork(this.options.extensionHostPath, [], {
            execArgv: [
                ...inheritedExecArgv(process.execArgv),
                ...inspectExecArgv('extension-host', process.env),
            ],
            execPath: this.options.executable ?? process.execPath,
            env: {
                ...safeProcessEnvironment(),
                ...logLevelEnvironment(process.env),
                CAXRI_APP_VERSION: this.options.appVersion,
                CAXRI_BUILD_ID: this.options.buildId,
                CAXRI_GIT_COMMIT: this.options.commit,
                CAXRI_LOG_DIRECTORY: dirname(this.options.logger.path),
                CAXRI_SERVER_BOOT_ID: this.options.bootId,
                CAXRI_SERVER_ID: this.options.serverId,
                CAXRI_USER_DATA_PATH: this.options.userDataPath,
            },
            serialization: 'advanced',
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        this.child = child;
        child.on('message', (message: unknown) => {
            if (this.child === child) this.onMessage(message);
        });
        child.on('exit', (code) => {
            if (this.child === child) this.handleExit(code ?? -1);
        });
        child.on('error', (error) =>
            this.options.logger.write('error', logEventCatalog.extensionHost.error, {
                fields: { message: error.message },
            }),
        );
        try {
            await this.readiness;
            await this.sendRequest('configure', { extensions: this.options.registrations() });
            this.options.logger.recordMetric('startup.phase', performance.now() - startedAt, {
                owner: 'extension-host',
                phase: 'startup',
                outcome: isRestart ? 'restart' : 'success',
            });
            if (isRestart)
                this.options.logger.recordMetric('process.restarts', 1, {
                    owner: 'extension-host',
                    phase: 'startup',
                    outcome: 'restart',
                });
        } catch (error) {
            this.options.logger.recordMetric('startup.phase', performance.now() - startedAt, {
                owner: 'extension-host',
                phase: 'startup',
                outcome: 'failure',
            });
            if (this.child === child) {
                this.rejectPendingRequests('Extension Host failed to start');
                await this.terminateChild(child);
            }
            throw error;
        }
        this.restartResetTimer = setTimeout(() => {
            this.restartCount = 0;
            this.restartResetTimer = undefined;
        }, RESTART_STABILITY_MS);
        this.restartResetTimer.unref();
        this.dispatchEvent(new Event('start'));
        this.injectNextProtocolFault(child);
    }

    private sendRequest(
        method: ExtensionHostRequest['method'],
        parameters: ExtensionHostRequest['params'],
    ): Promise<unknown> {
        if (this.pending.size >= MAX_CONCURRENT_REQUESTS)
            throw Object.assign(new Error('Extension Host request capacity exceeded'), {
                code: 'PROVIDER_CAPACITY',
            });
        const child = this.child;
        if (!child?.connected)
            throw Object.assign(new Error('Extension Host is unavailable'), {
                code: 'EXTENSION_HOST_UNAVAILABLE',
            });
        const id = randomUUID();
        const parentObservation = currentObservationContext();
        const observation = mergeObservationContext(parentObservation, {
            operationId: id,
            requestId: parentObservation.requestId ?? id,
            traceId: parentObservation.traceId ?? id,
        });
        return new Promise((resolve, reject) => {
            const timeout = requestTimeout(method, parameters);
            const timer =
                timeout === undefined
                    ? undefined
                    : setTimeout(() => {
                          this.pending.delete(id);
                          const requestId = cancellableRequestId(method, parameters);
                          if (requestId && child.connected)
                              child.send({
                                  id: randomUUID(),
                                  method: 'cancel',
                                  params: { requestId },
                                  observation,
                              } satisfies ExtensionHostRequest);
                          else if (
                              (method === 'activate' || method === 'executeCommand') &&
                              child === this.child
                          )
                              child.kill();
                          this.options.logger.write('warn', logEventCatalog.extensionHost.error, {
                              correlationId: id,
                              context: observation,
                              fields: { method, code: 'PROVIDER_TIMEOUT' },
                              failure: {
                                  code: 'PROVIDER_TIMEOUT',
                                  owner: 'extension-host',
                                  phase: 'execute',
                                  reason: 'timeout',
                                  remediation: 'restart-extension-host',
                                  retryable: true,
                              },
                          });
                          reject(
                              Object.assign(
                                  new Error(`Extension Host request timed out: ${method}`),
                                  { code: 'PROVIDER_TIMEOUT' },
                              ),
                          );
                      }, timeout);
            timer?.unref();
            this.pending.set(id, { method, resolve, reject, timer });
            child.send({ id, method, params: parameters, observation });
        });
    }

    async start(): Promise<void> {
        if (this.circuitOpen)
            throw Object.assign(
                new Error('Extension Host restart limit reached; an explicit retry is required'),
                { code: 'EXTENSION_HOST_UNAVAILABLE' },
            );
        if (this.startup) return this.startup;
        this.startup = this.startOnce();
        try {
            await this.startup;
        } catch (error) {
            if (!this.child) this.startup = undefined;
            throw error;
        }
    }

    async request(
        method: ExtensionHostRequest['method'],
        parameters: ExtensionHostRequest['params'],
    ): Promise<unknown> {
        await this.start();
        return this.sendRequest(method, parameters);
    }

    processId(): number | undefined {
        return this.child?.pid;
    }

    onEvent(
        listener: (event: Extract<ExtensionHostMessage, { type: 'event' }>) => void,
    ): () => void {
        const handler = (event: Event): void =>
            listener(
                (event as CustomEvent<Extract<ExtensionHostMessage, { type: 'event' }>>).detail,
            );
        this.addEventListener('event', handler);
        return () => this.removeEventListener('event', handler);
    }

    onExit(listener: (code: number) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<{ code: number }>).detail.code);
        this.addEventListener('exit', handler);
        return () => this.removeEventListener('exit', handler);
    }

    onStart(listener: () => void): () => void {
        this.addEventListener('start', listener);
        return () => this.removeEventListener('start', listener);
    }

    async restart(): Promise<void> {
        if (this.restartTimer) clearTimeout(this.restartTimer);
        if (this.restartResetTimer) clearTimeout(this.restartResetTimer);
        this.restartTimer = undefined;
        this.restartResetTimer = undefined;
        this.restartCount = 0;
        this.circuitOpen = false;
        const child = this.child;
        this.retireChild('Extension Host is restarting');
        if (child) await this.terminateChild(child);
        await this.start();
    }

    async shutdown(): Promise<void> {
        this.intentionalStop = true;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        if (this.restartResetTimer) clearTimeout(this.restartResetTimer);
        this.restartTimer = undefined;
        this.restartResetTimer = undefined;
        const child = this.child;
        if (!child) return;
        try {
            await this.request('shutdown', {});
        } catch {
            // The owned child is still terminated below if graceful shutdown failed.
        }
        this.child = undefined;
        this.startup = undefined;
        this.rejectPendingRequests('Extension Host is stopping');
        /**
         * The shutdown reply only confirms that the child scheduled its final lifecycle flush. Give it a bounded grace
         * period to publish `stopped` and exit before using the existing forced-termination fallback.
         */
        await this.waitForGracefulChildExit(child);
    }
}
