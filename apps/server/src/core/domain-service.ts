import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type {
    ProtocolEventEnvelope,
    ServerEvent,
    ServerOperation,
    ServerOperationArguments,
    ServerOperationParameters,
    ServerOperationRequest,
    ServerOperationResult,
    WorkbenchRequestContext,
} from '@caxri/protocol';
import {
    CaxriError,
    durableServerEventSchema,
    isNonExpiringServerOperation,
    logEventCatalog,
    parseServerOperationRequest,
    protocolEventEnvelopeSchema,
    toWireError,
} from '@caxri/protocol';

import { createDomainServices } from '../domains/create-domain-services';
import type { ServerCredentialStores } from '../domains/db';
import type { DomainDependencies, DomainServices } from '../domains/domain-services';
import type { ProtocolRecoveryState } from '../domains/protocol-recovery';
import { isAtomicStructuralMethod } from './atomic-structural-methods';
import type { DomainOperationDispatcher } from './operation-dispatcher';
import { createOperationDispatcher, resolveDomainHandler } from './operation-dispatcher';
import { requestFailureLogLevel } from './request-observability';

interface PendingOperation {
    abortCleanup?: () => void;
    reject(error: CaxriError): void;
    timer?: NodeJS.Timeout;
}

interface DomainEventDelivery {
    event: ServerEvent;
    persistedEnvelope?: ProtocolEventEnvelope;
}

export type ServerDomainDependencies = Omit<DomainDependencies, 'send'>;
export type CreateDomainServices = (dependencies: DomainDependencies) => Promise<DomainServices>;

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const ACTIVE_CONTEXT_EVENT = 'activeContext';

function requestTimeout(method: ServerOperation): number | undefined {
    return isNonExpiringServerOperation(method) ? undefined : DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Owns Server domain services in the Server Core process and invokes them without a generic IPC hop.
 */
export class ServerDomainService extends EventTarget {
    private atomicEvents?: ServerEvent[];
    private dispatch?: DomainOperationDispatcher;
    private readonly pending = new Map<string, PendingOperation>();
    private services?: DomainServices;
    private startPromise?: Promise<void>;
    private stopped = false;

    constructor(
        private readonly dependencies: ServerDomainDependencies,
        private readonly createServices: CreateDomainServices = createDomainServices,
    ) {
        super();
    }

    private publishEvent(event: ServerEvent, persistedEnvelope?: ProtocolEventEnvelope): void {
        if (this.atomicEvents) {
            if (persistedEnvelope)
                throw new CaxriError('INTERNAL', 'Nested persisted domain event is invalid');
            this.atomicEvents.push(event);
            return;
        }
        this.dispatchEvent(
            new CustomEvent<DomainEventDelivery>('event', {
                detail: { event, ...(persistedEnvelope && { persistedEnvelope }) },
            }),
        );
    }

    private async send(
        method: ServerOperation,
        parameters: unknown = {},
        timeoutMs = requestTimeout(method),
        context?: WorkbenchRequestContext,
        signal?: AbortSignal,
        finalizeDurably?: <Result>(commit: () => Result) => Result,
    ): Promise<unknown> {
        await this.start();
        const dispatch = this.dispatch;
        if (!dispatch) throw new CaxriError('UNAVAILABLE', 'Server Core is unavailable');
        const id = randomUUID();
        return new Promise<unknown>((resolve, reject) => {
            if (signal?.aborted) {
                reject(new CaxriError('CANCELLED', 'Runtime request was canceled'));
                return;
            }
            let onAbort = (): void => {};
            const timer =
                timeoutMs === undefined
                    ? undefined
                    : setTimeout(() => {
                          this.cancelRequest(
                              id,
                              new CaxriError('TIMEOUT', `Runtime request timed out: ${method}`),
                          );
                      }, timeoutMs);
            const pending: PendingOperation = {
                reject,
                timer,
                abortCleanup: signal
                    ? () => signal.removeEventListener('abort', onAbort)
                    : undefined,
            };
            const settle = (action: () => void): void => {
                if (!this.pending.delete(id)) return;
                if (timer) clearTimeout(timer);
                pending.abortCleanup?.();
                action();
            };
            onAbort = () => this.cancelRequest(id);
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            this.pending.set(id, pending);
            // The Promise constructor must expose its waiter before the operation completes; `runOperation` owns both
            // settlement branches and this final catch only fences an unexpected callback failure.
            const operation = this.runOperation(
                dispatch,
                {
                    id,
                    method,
                    params: parameters,
                    ...(context && { context }),
                    ...(finalizeDurably && { finalizeDurably }),
                },
                (result) => settle(() => resolve(result)),
                (error) => settle(() => reject(error)),
            );
            // eslint-disable-next-line unicorn/prefer-await -- deliberately detached operation, see comment above
            operation.catch(() => {});
        });
    }

    /**
     * Owns completion handling so a caller can be canceled immediately without awaiting a non-cooperative handler.
     */
    private async runOperation(
        dispatch: DomainOperationDispatcher,
        envelope: Parameters<DomainOperationDispatcher>[0],
        resolve: (result: unknown) => void,
        reject: (error: CaxriError) => void,
    ): Promise<void> {
        try {
            resolve(await dispatch(envelope));
        } catch (error) {
            reject(
                error instanceof CaxriError
                    ? error
                    : new CaxriError('INTERNAL', 'Server Core operation failed'),
            );
        }
    }

    private commitDurableResult<Result>(
        method: ServerOperation,
        requestId: string,
        persistResult: (result: unknown) => void,
        commit: () => Result,
    ): Result {
        const services = this.services;
        if (!services) throw new CaxriError('UNAVAILABLE', 'Server Core is unavailable');
        if (this.atomicEvents)
            throw new CaxriError('CONFLICT', 'A structural transaction is already active');
        const startedAt = performance.now();
        const events: ServerEvent[] = [];
        const persisted: ProtocolEventEnvelope[] = [];
        const identity = services.protocolRecovery.identity();
        this.atomicEvents = events;
        try {
            const result = services.protocolRecovery.transaction(() => {
                const outcome = commit();
                if (
                    typeof outcome === 'object' &&
                    outcome !== null &&
                    'then' in outcome &&
                    typeof outcome.then === 'function'
                )
                    throw new CaxriError(
                        'INTERNAL',
                        `${method} durable finalization must be synchronous`,
                    );
                for (const event of events) {
                    const durableEvent = durableServerEventSchema.parse(event);
                    persisted.push(
                        protocolEventEnvelopeSchema.parse({
                            ...services.protocolRecovery.appendEvent(
                                identity.stateEpoch,
                                durableEvent,
                            ),
                            ...identity,
                        }),
                    );
                }
                persistResult(outcome);
                return outcome;
            });
            this.atomicEvents = undefined;
            for (const [index, event] of events.entries())
                this.publishEvent(event, persisted[index]);
            this.dependencies.logger.write('debug', logEventCatalog.ipc.request, {
                correlationId: requestId,
                durationMs: performance.now() - startedAt,
                fields: { method, transaction: 'durable-finalizer' },
            });
            return result;
        } catch (error) {
            const wire = toWireError(error);
            this.dependencies.logger.write(
                requestFailureLogLevel(method, wire.code),
                logEventCatalog.ipc.requestFailed,
                {
                    correlationId: requestId,
                    durationMs: performance.now() - startedAt,
                    fields: {
                        method,
                        code: wire.code,
                        error: wire.message,
                        stack:
                            wire.code === 'INTERNAL' && error instanceof Error
                                ? (error.stack ?? null)
                                : null,
                        transaction: 'durable-finalizer',
                    },
                },
            );
            throw error;
        } finally {
            this.atomicEvents = undefined;
        }
    }

    start(): Promise<void> {
        if (this.services) return Promise.resolve();
        if (this.stopped)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Server Core has been stopped'));
        this.startPromise ??= (async () => {
            const startedAt = performance.now();
            const services = await this.createServices({
                ...this.dependencies,
                send: (event) => this.publishEvent(event),
            });
            if (this.stopped) {
                await services.close();
                throw new CaxriError('UNAVAILABLE', 'Server Core has been stopped');
            }
            this.services = services;
            services.onActiveContextChanged?.(() =>
                this.dispatchEvent(new Event(ACTIVE_CONTEXT_EVENT)),
            );
            this.dispatch = createOperationDispatcher(
                services.handlers,
                this.dependencies.logger,
                (context) => services.validateRequestContext(context),
            );
            this.dependencies.logger.write('info', logEventCatalog.serverCore.domainsReady, {
                durationMs: performance.now() - startedAt,
                fields: { pid: process.pid },
            });
            this.publishEvent({
                event: 'runtime.status',
                payload: { status: 'ready', restartCount: 0 },
            });
        })();
        return this.startPromise;
    }

    cancelRequest(
        requestId: string,
        reason = new CaxriError('CANCELLED', 'Runtime request was canceled'),
    ): boolean {
        const pending = this.pending.get(requestId);
        if (!pending) return false;
        this.pending.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        pending.abortCleanup?.();
        this.dispatch?.cancel(requestId);
        pending.reject(reason);
        return true;
    }

    onEvent(
        listener: (event: ServerEvent, persistedEnvelope?: ProtocolEventEnvelope) => void,
    ): () => void {
        const handler = (event: Event): void => {
            const delivery = (event as CustomEvent<DomainEventDelivery>).detail;
            listener(delivery.event, delivery.persistedEnvelope);
        };
        this.addEventListener('event', handler);
        return () => this.removeEventListener('event', handler);
    }

    /**
     * Forgets per-connection memory state (window presence) once the socket that reported it closed.
     */
    onConnectionClosed(connectionId: string): void {
        this.services?.onConnectionClosed?.(connectionId);
    }

    /**
     * Fires when the Session the user is in changes without any `state.changed` event, for example when window focus
     * moves between two windows showing different Sessions.
     */
    onActiveContextChanged(listener: () => void): () => void {
        this.addEventListener(ACTIVE_CONTEXT_EVENT, listener);
        return () => this.removeEventListener(ACTIVE_CONTEXT_EVENT, listener);
    }

    request<M extends ServerOperation>(
        method: M,
        ...arguments_: ServerOperationArguments<M>
    ): Promise<ServerOperationResult<M>> {
        const [parameters, timeoutMs] = arguments_;
        return this.send(method, parameters, timeoutMs) as Promise<ServerOperationResult<M>>;
    }

    async recoveryState(): Promise<ProtocolRecoveryState> {
        await this.start();
        if (!this.services)
            throw new CaxriError('UNAVAILABLE', 'Server recovery state is unavailable');
        return this.services.protocolRecovery;
    }

    /**
     * The started domain's credential storage; Server Core opens its paired-phone and delegation registries on it.
     */
    async credentialStores(): Promise<ServerCredentialStores> {
        await this.start();
        if (!this.services)
            throw new CaxriError('UNAVAILABLE', 'Server credentials are unavailable');
        return this.services.credentials;
    }

    requestWithSignal<M extends ServerOperation>(
        method: M,
        parameters: ServerOperationParameters<M>,
        signal: AbortSignal,
        timeoutMs = requestTimeout(method),
    ): Promise<ServerOperationResult<M>> {
        return this.send(method, parameters, timeoutMs, undefined, signal) as Promise<
            ServerOperationResult<M>
        >;
    }

    requestInWorkbenchContext<M extends ServerOperation>(
        method: M,
        parameters: ServerOperationParameters<M>,
        context: WorkbenchRequestContext,
        timeoutMs?: number,
        signal?: AbortSignal,
    ): Promise<ServerOperationResult<M>> {
        return this.send(
            method,
            parameters,
            timeoutMs ?? requestTimeout(method),
            context,
            signal,
        ) as Promise<ServerOperationResult<M>>;
    }

    forward(
        method: ServerOperation,
        parameters: unknown,
        timeoutMs?: number,
        signal?: AbortSignal,
    ): Promise<unknown> {
        return this.send(method, parameters, timeoutMs, undefined, signal);
    }

    /**
     * Lets an asynchronous external-effect handler commit its final SQLite state and durable receipt together after the
     * external operation succeeds. The supplied closure must remain synchronous so no unrelated event can enter the
     * transaction-scoped buffer.
     */
    forwardWithDurableFinalizer(
        request: ServerOperationRequest,
        requestId: string,
        persistResult: (result: unknown) => void,
        signal?: AbortSignal,
    ): Promise<unknown> {
        return this.send(
            request.method,
            request.params,
            undefined,
            undefined,
            signal,
            <Result>(commit: () => Result) =>
                this.commitDurableResult(request.method, requestId, persistResult, commit),
        );
    }

    tryForwardDurableCommand(
        request: ServerOperationRequest,
        requestId: string,
        persistResult: ((result: unknown) => void) | undefined,
        runCancellable: <Result>(task: (signal: AbortSignal) => Promise<Result>) => Promise<Result>,
    ): { result: unknown } | undefined {
        if (!persistResult) return;
        if (isAtomicStructuralMethod(request.method))
            return { result: this.forwardAtomically(request, requestId, persistResult) };
        if (request.method !== 'session.rename') return;
        return {
            result: runCancellable((signal) =>
                this.forwardWithDurableFinalizer(request, requestId, persistResult, signal),
            ),
        };
    }

    /**
     * Executes one reviewed synchronous structural handler inside the owning SQLite transaction. The handler's state
     * changes, its content-free events, and the protocol dispatcher's successful receipt either all commit or all roll
     * back. External-effect and asynchronous handlers are deliberately rejected from this path.
     */
    forwardAtomically(
        request: ServerOperationRequest,
        requestId: string,
        persistResult: (result: unknown) => void,
    ): unknown {
        const services = this.services;
        if (!services) throw new CaxriError('UNAVAILABLE', 'Server Core is unavailable');
        const parsed = parseServerOperationRequest(request.method, request.params);
        const handler = resolveDomainHandler(services.handlers, parsed.method);
        return this.commitDurableResult(parsed.method, requestId, persistResult, () =>
            handler(parsed.params),
        );
    }

    async shutdown(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        for (const [requestId] of this.pending) this.cancelRequest(requestId);
        const services = this.services;
        this.services = undefined;
        this.dispatch = undefined;
        if (services) await services.close();
    }
}
