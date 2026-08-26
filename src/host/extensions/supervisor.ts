import { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';

import type { CaxriErrorCode } from '@caxri/protocol';
import {
    CaxriError,
    errorCodes,
    extensionViewChangeSchema,
    extensionViewEventContextSchema,
    extensionViewEventIdSchema,
    isNonExpiringViewOperation,
    MAX_VIEW_TREE_ITEMS,
    MAX_VIEW_TREE_PAYLOAD_BYTES,
    treeItemSchema,
} from '@caxri/protocol';

import type {
    ExtensionHostApiRequest,
    ExtensionHostMessage,
    ExtensionHostRegistration,
    ExtensionHostRequest,
} from '../../shared/extension-host-protocol';
import {
    extensionWorkspaceOperations,
    MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH,
} from '../../shared/extension-host-protocol';
import type { StructuredLogger } from '../../shared/node/logger';
import { logEventCatalog } from '../../shared/node/logger';
import { safeProcessEnvironment } from '../../shared/node/process-environment';

interface PendingRequest {
    method: ExtensionHostRequest['method'];
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer?: NodeJS.Timeout;
}

export interface ExtensionHostSupervisorOptions {
    appVersion: string;
    commit: string;
    executable?: string;
    extensionHostPath: string;
    logger: StructuredLogger;
    registrations(): ExtensionHostRegistration[];
    requestApi(request: ExtensionHostApiRequest, signal?: AbortSignal): Promise<unknown>;
}

const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_AUTO_RESTARTS = 5;
const RESTART_STABILITY_MS = 30_000;
const MAX_EXTENSION_API_ARGUMENT_BYTES = 64 * 1_024;
const MAX_EXTENSION_VIEW_RESULT_BYTES = 4 * 1024 * 1024;

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Re-reads mutable child state after an awaited request so replies never target a disconnected child.
 */
function isChildConnected(child: ChildProcess): boolean {
    return child.connected;
}

function isBoundedString(value: unknown, max: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function hasBoundedApiArguments(value: unknown): boolean {
    if (!isRecord(value)) return false;
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_EXTENSION_API_ARGUMENT_BYTES;
    } catch {
        return false;
    }
}

function isViewChange(value: unknown): boolean {
    return extensionViewChangeSchema.safeParse(value).success;
}

function hasBoundedViewResult(value: unknown): boolean {
    if (value === undefined || ['bigint', 'function', 'symbol'].includes(typeof value))
        return false;
    try {
        const serialized = JSON.stringify(value);
        return Buffer.byteLength(serialized, 'utf8') <= MAX_EXTENSION_VIEW_RESULT_BYTES;
    } catch {
        return false;
    }
}

export function extensionHostReplyError(error: { code: string; message: string }): Error {
    if (errorCodes.includes(error.code as CaxriErrorCode))
        return new CaxriError(error.code as CaxriErrorCode, error.message);
    return Object.assign(new Error(error.message), { code: error.code });
}

export function isExtensionHostMessage(value: unknown): value is ExtensionHostMessage {
    if (!isRecord(value) || typeof value.type !== 'string') return false;
    if (value.type === 'ready') return true;
    if (value.type === 'api-request')
        return (
            isBoundedString(value.id, 200) &&
            isBoundedString(value.extensionId, 200) &&
            Number.isSafeInteger(value.generation) &&
            Number(value.generation) >= 0 &&
            isBoundedString(value.apiToken, 200) &&
            isRecord(value.params) &&
            ((value.method === 'workspace.getProjectStatus' &&
                (value.params.refreshToken === undefined ||
                    isBoundedString(
                        value.params.refreshToken,
                        MAX_EXTENSION_PROJECT_STATUS_REFRESH_TOKEN_LENGTH,
                    ))) ||
                (value.method === 'workspace.getConfiguration' &&
                    isBoundedString(value.params.key, 200)) ||
                (value.method === 'workspace.request' &&
                    typeof value.params.operation === 'string' &&
                    extensionWorkspaceOperations.includes(
                        value.params.operation as (typeof extensionWorkspaceOperations)[number],
                    ) &&
                    extensionViewEventContextSchema.safeParse(value.params.context).success &&
                    hasBoundedApiArguments(value.params.arguments)))
        );
    if (value.type === 'api-cancel') return isBoundedString(value.id, 200);
    if (value.type === 'event') {
        const isIdentityIsValid =
            isBoundedString(value.extensionId, 200) &&
            Number.isSafeInteger(value.generation) &&
            Number(value.generation) >= 0 &&
            isBoundedString(value.viewId, 200) &&
            extensionViewEventIdSchema.safeParse(value.eventId).success &&
            extensionViewEventContextSchema.safeParse(value.context).success;
        if (!isIdentityIsValid) return false;
        if (value.event === 'viewChanged') return isViewChange(value.change);
        return (
            value.event === 'treeChanged' &&
            (value.handles === undefined ||
                (Array.isArray(value.handles) &&
                    value.handles.length <= MAX_VIEW_TREE_ITEMS &&
                    value.handles.every((handle) => isBoundedString(handle, 512))))
        );
    }
    if (value.type !== 'reply' || !isBoundedString(value.id, 200) || typeof value.ok !== 'boolean')
        return false;
    return (
        value.ok ||
        (isRecord(value.error) &&
            isBoundedString(value.error.code, 100) &&
            isBoundedString(value.error.message, 2_048))
    );
}

export function isExtensionHostResult(
    method: ExtensionHostRequest['method'],
    value: unknown,
): boolean {
    if (method === 'viewOperation') return hasBoundedViewResult(value);
    if (!isRecord(value)) return false;
    switch (method) {
        case 'configure':
            return Number.isSafeInteger(value.configured) && Number(value.configured) >= 0;
        case 'activate':
            return value.activated === true;
        case 'treeChildren':
            return (
                Array.isArray(value.items) &&
                value.items.length <= MAX_VIEW_TREE_ITEMS &&
                value.items.every((item) => treeItemSchema.safeParse(item).success) &&
                Buffer.byteLength(JSON.stringify(value), 'utf8') <=
                    MAX_VIEW_TREE_PAYLOAD_BYTES + 1_024
            );
        case 'executeCommand':
            return value.executed === true;
        case 'activeContextChanged':
        case 'gitChanged':
        case 'projectStatusChanged':
            return Number.isSafeInteger(value.notified) && Number(value.notified) >= 0;
        case 'cancel':
            return typeof value.cancelled === 'boolean';
        case 'shutdown':
            return value.stopped === true;
    }
}

/**
 * Host-owned lifecycle for the shared ESM Extension Host. Runtime and PTYs remain unaffected by this child.
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

    constructor(private readonly options: ExtensionHostSupervisorOptions) {
        super();
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

    private async handleApiRequest(request: ExtensionHostApiRequest): Promise<void> {
        const child = this.child;
        if (!child?.connected) return;
        const controller = new AbortController();
        this.apiRequests.set(request.id, controller);
        try {
            const result = await this.options.requestApi(request, controller.signal);
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

    private onMessage(value: unknown): void {
        if (!isExtensionHostMessage(value)) {
            this.options.logger.write('error', logEventCatalog.extensionHost.invalidMessage);
            this.child?.kill();
            return;
        }
        const message = value;
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
            this.options.logger.write('error', logEventCatalog.extensionHost.invalidMessage);
            this.child?.kill();
        } else if (message.ok) pending.resolve(message.result);
        else pending.reject(extensionHostReplyError(message.error));
    }

    private handleExit(code: number): void {
        for (const controller of this.apiRequests.values()) controller.abort();
        this.apiRequests.clear();
        if (this.restartResetTimer) clearTimeout(this.restartResetTimer);
        this.restartResetTimer = undefined;
        this.child = undefined;
        this.readiness = undefined;
        this.startup = undefined;
        this.rejectReady?.(new Error('Extension Host exited before becoming ready'));
        this.rejectReady = undefined;
        this.resolveReady = undefined;
        this.rejectPendingRequests(`Extension Host exited with code ${code}`);
        if (this.intentionalStop) return;
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
            execPath: this.options.executable ?? process.execPath,
            env: {
                ...safeProcessEnvironment(),
                ELECTRON_RUN_AS_NODE: '1',
                CAXRI_APP_VERSION: this.options.appVersion,
                CAXRI_GIT_COMMIT: this.options.commit,
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
        } catch (error) {
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
                              } satisfies ExtensionHostRequest);
                          else if (
                              (method === 'activate' || method === 'executeCommand') &&
                              child === this.child
                          )
                              child.kill();
                          reject(
                              Object.assign(
                                  new Error(`Extension Host request timed out: ${method}`),
                                  { code: 'PROVIDER_TIMEOUT' },
                              ),
                          );
                      }, timeout);
            timer?.unref();
            this.pending.set(id, { method, resolve, reject, timer });
            child.send({ id, method, params: parameters });
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
        this.child = undefined;
        this.readiness = undefined;
        this.startup = undefined;
        this.rejectPendingRequests('Extension Host is restarting');
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
        await this.terminateChild(child);
    }
}
