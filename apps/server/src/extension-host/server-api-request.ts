import { randomUUID } from 'node:crypto';

import { isNonExpiringViewOperation } from '@caxri/protocol';
import { currentObservationContext, mergeObservationContext } from '@caxri/system';
import type { CancellationToken, DisposableLike } from 'caxri';

import type { ProviderRequestScope } from './extension-error';
import { currentProviderRequestScope, hostError, recordHostApiRejection } from './extension-error';
import type { ExtensionHostApiRequest, ExtensionHostMessage } from './protocol';
import { currentViewEventContext } from './view-event-context';

type ExtensionHostApiRequestIdentity =
    'apiToken' | 'extensionId' | 'generation' | 'id' | 'observation' | 'type';

export type ServerApiRequestInput =
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
    /**
     * The provider request that issued this call, captured at issue time because the reply arrives on the IPC message
     * handler, outside that request's async context.
     */
    scope?: ProviderRequestScope;
    /**
     * A `workspace.request` issued outside any host-supplied view event context, so the call declared its own
     * `no-session` scope. Server Core's controlled-view fence rejects such a call with `CANCELLED` whenever a Session
     * is active; that reports the extension's mis-scoped call, not the host's own turnover, so it must neither be
     * minted host-originated nor mark the issuing request (issue #606). The one host-driven case this misses — a
     * Session becoming active between issue and admission of a call made while none was — is deliberately kept a fault
     * rather than opening the channel to extension-provoked rejections.
     */
    selfScoped?: boolean;
    timer?: NodeJS.Timeout;
    /**
     * The call's own token was cancelled while the request stayed pending for an authoritative reply. A `CANCELLED`
     * reply that follows is then the token's doing, not Server Core's own decision.
     */
    tokenCancelled?: boolean;
    sendCancel(): void;
}

export interface ServerApiRequestContext {
    apiToken: string;
    assertCurrent(): void;
    isApiTokenCurrent(apiToken: string): boolean;
    send(message: ExtensionHostMessage): void;
}

const pendingApi = new Map<string, PendingApiRequest>();
const SERVER_API_TIMEOUT_MS = 15_000;

function cancellationError(): Error {
    return hostError('CANCELLED', 'Extension Host API request was cancelled');
}

function clearPending(id: string, pending: PendingApiRequest): void {
    pendingApi.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.cancellation?.dispose();
}

/**
 * Rejects on the host's own behalf. Besides minting the error host-originated, this tells the owning provider request
 * that the host cancelled or expired one of its API calls, so a provider that propagates the rejection unchanged is
 * still classified as a non-fault at the provider boundary. A `CANCELLED` that merely echoes the call's own token is
 * not the host's decision and is not recorded.
 */
function rejectAsHost(pending: PendingApiRequest, code: string, message: string): void {
    if (!(code === 'CANCELLED' && pending.tokenCancelled))
        recordHostApiRejection(pending.scope, code);
    pending.reject(hostError(code, message));
}

function requestTimeout(request: ServerApiRequestInput): number | undefined {
    return request.method === 'workspace.request' &&
        isNonExpiringViewOperation(request.params.operation)
        ? undefined
        : SERVER_API_TIMEOUT_MS;
}

function requiresAuthoritativeReplyAfterCancellation(request: ServerApiRequestInput): boolean {
    return (
        request.method === 'workspace.request' &&
        isNonExpiringViewOperation(request.params.operation)
    );
}

/**
 * Sends one Extension API request and wires a public CancellationToken to the authenticated Server request id. The id
 * is reused by transport admission and domain cancellation so a late cancel cannot target another operation.
 */
export function requestServerApi<Result>(
    context: ServerApiRequestContext & {
        extensionId: string;
        generation: number;
    },
    request: ServerApiRequestInput,
    token?: CancellationToken,
): Promise<Result> {
    context.assertCurrent();
    if (token?.isCancellationRequested) return Promise.reject(cancellationError());
    const id = randomUUID();
    const parentObservation = currentObservationContext();
    const message = {
        type: 'api-request',
        id,
        extensionId: context.extensionId,
        generation: context.generation,
        apiToken: context.apiToken,
        observation: mergeObservationContext(parentObservation, {
            operationId: id,
            requestId: parentObservation.requestId ?? id,
            traceId: parentObservation.traceId ?? id,
        }),
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
            scope: currentProviderRequestScope(),
            selfScoped:
                request.method === 'workspace.request' && currentViewEventContext() === undefined,
            timer,
            sendCancel: () => context.send({ type: 'api-cancel', id }),
        };
        pending.cancellation = token?.onCancellationRequested(() => {
            const current = pendingApi.get(id);
            if (current !== pending) return;
            pending.tokenCancelled = true;
            pending.sendCancel();
            /**
             * A mutation cancel is a request to stop before its point of no return, not proof that it stopped. Server
             * may already be applying the operation without a signal, so only its reply can distinguish cancellation
             * from authoritative completion and prevent a duplicate retry.
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
        rejectAsHost(pending, 'GENERATION_EXPIRED', 'Extension generation was reconfigured');
        return;
    }
    if (message.ok) {
        pending.resolve(message.result);
        return;
    }
    const code = message.error?.code ?? 'EXTENSION_HOST_UNAVAILABLE';
    const description = message.error?.message ?? 'Host API request failed';
    // See `PendingApiRequest.selfScoped`: the fence answered the extension's own scoping, not a host decision.
    if (code === 'CANCELLED' && pending.selfScoped) {
        pending.reject(Object.assign(new Error(description), { code }));
        return;
    }
    /**
     * This rebuilds an error from Server Core's own reply rather than from anything an extension threw, so it is
     * host-originated the same way a locally-raised `CANCELLED` / `GENERATION_EXPIRED` is.
     */
    rejectAsHost(pending, code, description);
}

export function rejectPendingApiRequests(message: string, code = 'GENERATION_EXPIRED'): void {
    for (const [id, pending] of pendingApi) {
        clearPending(id, pending);
        rejectAsHost(pending, code, message);
    }
}
