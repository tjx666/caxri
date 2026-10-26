import { AsyncLocalStorage } from 'node:async_hooks';

import { CaxriError } from '@caxri/protocol';
import { waitForSharedOperation } from '@caxri/system';

import { runAsSharedWork } from '../../observability/background-work';

const requestSignals = new AsyncLocalStorage<AbortSignal | undefined>();

export function withGitRequestSignal<Result>(
    signal: AbortSignal | undefined,
    callback: () => Promise<Result>,
): Promise<Result> {
    return signal ? requestSignals.run(signal, callback) : callback();
}

export function currentGitRequestSignal(): AbortSignal | undefined {
    return requestSignals.getStore();
}

export function gitSignalOptions(): { signal?: AbortSignal } {
    const signal = currentGitRequestSignal();
    return signal ? { signal } : {};
}

/**
 * Establishes the point of no return for a native Git mutation. Cancellation is honored before entry; after entry the
 * child operations finish without the request signal so Server can return one authoritative completion to the caller.
 */
export async function authoritativeGitMutation<Result>(
    callback: () => Promise<Result>,
): Promise<Result> {
    const signal = currentGitRequestSignal();
    if (signal?.aborted) throw new CaxriError('CANCELLED', 'Runtime request was canceled');
    return requestSignals.run(undefined, callback);
}

/**
 * Detaches a shared Git producer from one consumer's cancellation and cancels only that consumer's wait. A summary,
 * topology, history, or Pull Request load may be joined by another request, so killing its child process when the first
 * consumer leaves would incorrectly fail every waiter. For the same reason the producer runs at foreground priority: a
 * `session.select` joining a load a background poll started must not wait behind the background cap.
 */
export async function sharedGitRequest<Result>(load: () => Promise<Result>): Promise<Result> {
    const signal = currentGitRequestSignal();
    const operation = requestSignals.run(undefined, () => runAsSharedWork(load));
    return waitForSharedOperation(
        operation,
        signal,
        () => new CaxriError('CANCELLED', 'Runtime request was canceled'),
    );
}
