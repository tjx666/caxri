import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type {
    ServerEvent,
    ServerOperation,
    ServerOperationArguments as ServerOperationArguments,
    ServerOperationParameters as ServerOperationParameters,
    ServerOperationResult,
    WorkbenchRequestContext,
} from '@caxri/protocol';
import { CaxriError, isNonExpiringServerOperation } from '@caxri/protocol';

import { createDomainServices } from '../domains/create-domain-services';
import type { DomainDependencies, DomainServices } from '../domains/domain-services';
import type { DomainOperationDispatcher } from './operation-dispatcher';
import { createOperationDispatcher } from './operation-dispatcher';

interface PendingOperation {
    abortCleanup?: () => void;
    reject(error: CaxriError): void;
    timer?: NodeJS.Timeout;
}

export type ServerDomainDependencies = Omit<DomainDependencies, 'send'>;
export type CreateDomainServices = (dependencies: DomainDependencies) => Promise<DomainServices>;

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

function requestTimeout(method: ServerOperation): number | undefined {
    return isNonExpiringServerOperation(method) ? undefined : DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Owns Server domain services in the Server Core process and invokes them without a generic IPC hop.
 */
export class ServerDomainService extends EventTarget {
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

    private async send(
        method: ServerOperation,
        parameters: unknown = {},
        timeoutMs = requestTimeout(method),
        context?: WorkbenchRequestContext,
        signal?: AbortSignal,
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
                { id, method, params: parameters, ...(context && { context }) },
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

    start(): Promise<void> {
        if (this.services) return Promise.resolve();
        if (this.stopped)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Server Core has been stopped'));
        this.startPromise ??= (async () => {
            const startedAt = performance.now();
            const services = await this.createServices({
                ...this.dependencies,
                send: (event) =>
                    this.dispatchEvent(new CustomEvent<ServerEvent>('event', { detail: event })),
            });
            if (this.stopped) {
                await services.close();
                throw new CaxriError('UNAVAILABLE', 'Server Core has been stopped');
            }
            this.services = services;
            this.dispatch = createOperationDispatcher(
                services.handlers,
                this.dependencies.logger,
                (context) => services.validateRequestContext(context),
            );
            this.dependencies.logger.write('info', 'runtime.ready', {
                durationMs: performance.now() - startedAt,
                fields: { pid: process.pid },
            });
            this.dispatchEvent(
                new CustomEvent<ServerEvent>('event', {
                    detail: {
                        event: 'runtime.status',
                        payload: { status: 'ready', restartCount: 0 },
                    },
                }),
            );
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

    onEvent(listener: (event: ServerEvent) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<ServerEvent>).detail);
        this.addEventListener('event', handler);
        return () => this.removeEventListener('event', handler);
    }

    request<M extends ServerOperation>(
        method: M,
        ...arguments_: ServerOperationArguments<M>
    ): Promise<ServerOperationResult<M>> {
        const [parameters, timeoutMs] = arguments_;
        return this.send(method, parameters, timeoutMs) as Promise<ServerOperationResult<M>>;
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
