import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The connection a request arrived on. Domain handlers receive parameters only, so Server Core wraps each control
 * request in this scope and the few handlers that must tell connections apart (per-window presence) read it back.
 * Requests that did not come from a connection, such as internal Server work, see {@link INTERNAL_CONNECTION_ID}.
 */
const origin = new AsyncLocalStorage<{ connectionId: string | undefined }>();

const INTERNAL_CONNECTION_ID = 'internal';

export function runWithRequestOrigin<Result>(
    connectionId: string | undefined,
    task: () => Result,
): Result {
    return origin.run({ connectionId }, task);
}

export function currentConnectionId(): string {
    return origin.getStore()?.connectionId ?? INTERNAL_CONNECTION_ID;
}
