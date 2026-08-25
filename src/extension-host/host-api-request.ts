import { randomUUID } from 'node:crypto';

import type { CancellationToken, DisposableLike } from 'caxri';

import type {
    ExtensionHostApiRequest,
    ExtensionHostMessage,
} from '../shared/extension-host-protocol';
import { isNonExpiringViewOperation } from '../shared/ipc/request-lifetime';

type ExtensionHostApiRequestIdentity = 'apiToken' | 'extensionId' | 'generation' | 'id' | 'type';

export type HostApiRequestInput =
    | Omit<
          Extract<ExtensionHostApiRequest, { method: 'workspace.getProjectStatus' }>,
          ExtensionHostApiRequestIdentity
      >
    | Omit<
          Extract<ExtensionHostApiRequest, { method: 'workspace.getConfiguration' }>,
          ExtensionHostApiRequestIdentity
      >
    | Omit<
          Extract<ExtensionHostApiRequest, { method: 'workspace.request' }>,
          ExtensionHostApiRequestIdentity
      >;

interface PendingApiRequest {
    apiToken: string;
    cancellation?: DisposableLike;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer?: NodeJS.Timeout;
    sendCancel(): void;
}

export interface HostApiRequestContext {
    apiToken: string;
    assertCurrent(): void;
    isApiTokenCurrent(apiToken: string): boolean;
    send(message: ExtensionHostMessage): void;
}

const pendingApi = new Map<string, PendingApiRequest>();
const HOST_API_TIMEOUT_MS = 15_000;

function cancellationError(): Error {
    return Object.assign(new Error('Extension Host API request was cancelled'), {
        code: 'CANCELLED',
    });
}

function clearPending(id: string, pending: PendingApiRequest): void {
    pendingApi.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.cancellation?.dispose();
}

function requestTimeout(request: HostApiRequestInput): number | undefined {
    return request.method === 'workspace.request' &&
        isNonExpiringViewOperation(request.params.operation)
        ? undefined
        : HOST_API_TIMEOUT_MS;
}

function requiresAuthoritativeReplyAfterCancellation(request: HostApiRequestInput): boolean {
    return (
        request.method === 'workspace.request' &&
        isNonExpiringViewOperation(request.params.operation)
    );
}

/**
 * Sends one Extension API request and wires a public CancellationToken to the authenticated Host request id. The id is
 * intentionally reused for the Host and Runtime cancellation frames so a late cancel cannot target another operation.
 */
export function requestHostApi<Result>(
    context: HostApiRequestContext & {
        extensionId: string;
        generation: number;
    },
    request: HostApiRequestInput,
    token?: CancellationToken,
): Promise<Result> {
    context.assertCurrent();
    if (token?.isCancellationRequested) return Promise.reject(cancellationError());
    const id = randomUUID();
    const message = {
        type: 'api-request',
        id,
        extensionId: context.extensionId,
        generation: context.generation,
        apiToken: context.apiToken,
        ...request,
    } as ExtensionHostApiRequest;
    const requiresAuthoritativeReply = requiresAuthoritativeReplyAfterCancellation(request);
    return new Promise((resolve, reject) => {
        const timeout = requestTimeout(request);
        const timer =
            timeout === undefined
                ? undefined
                : setTimeout(() => {
                      const pending = pendingApi.get(id);
                      if (!pending) return;
                      clearPending(id, pending);
                      pending.sendCancel();
                      reject(
                          Object.assign(new Error('Host API request timed out'), {
                              code: 'PROVIDER_TIMEOUT',
                          }),
                      );
                  }, timeout);
        timer?.unref();
        const pending: PendingApiRequest = {
            apiToken: context.apiToken,
            resolve,
            reject,
            timer,
            sendCancel: () => context.send({ type: 'api-cancel', id }),
        };
        pending.cancellation = token?.onCancellationRequested(() => {
            const current = pendingApi.get(id);
            if (current !== pending) return;
            pending.sendCancel();
            /**
             * A mutation cancel is a request to stop before its point of no return, not proof that it stopped. Host may
             * already be applying the operation without a signal, so only its reply can distinguish cancellation from
             * authoritative completion and prevent a duplicate retry.
             */
            if (requiresAuthoritativeReply) return;
            clearPending(id, pending);
            reject(cancellationError());
        });
        pendingApi.set(id, pending);
        context.send(message);
    });
}

export function settleApiReply(
    message: {
        id: string;
        ok: boolean;
        result?: unknown;
        error?: { code: string; message: string };
    },
    isApiTokenCurrent: (apiToken: string) => boolean,
): void {
    const pending = pendingApi.get(message.id);
    if (!pending) return;
    clearPending(message.id, pending);
    if (!isApiTokenCurrent(pending.apiToken)) {
        pending.reject(
            Object.assign(new Error('Extension generation was reconfigured'), {
                code: 'GENERATION_EXPIRED',
            }),
        );
        return;
    }
    if (message.ok) pending.resolve(message.result);
    else
        pending.reject(
            Object.assign(new Error(message.error?.message ?? 'Host API request failed'), {
                code: message.error?.code ?? 'EXTENSION_HOST_UNAVAILABLE',
            }),
        );
}

export function rejectPendingApiRequests(message: string, code = 'GENERATION_EXPIRED'): void {
    for (const [id, pending] of pendingApi) {
        clearPending(id, pending);
        pending.reject(Object.assign(new Error(message), { code }));
    }
}
