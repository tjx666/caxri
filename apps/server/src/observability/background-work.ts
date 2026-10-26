import { AsyncLocalStorage } from 'node:async_hooks';

import type { BackgroundWorkSource } from '@caxri/protocol';

import type { BackgroundLoadGate } from './machine-load';
import { machineLoad } from './machine-load';

const scope = new AsyncLocalStorage<BackgroundWorkSource>();

/**
 * Runs `action` as background work, so the Git commands it issues queue behind every foreground request. The class is
 * set explicitly by each driver rather than inferred from the request context: a background timer armed inside a
 * request inherits that request's context, and would otherwise pass for foreground work.
 */
export function runAsBackgroundWork<Result>(
    source: BackgroundWorkSource,
    action: () => Result,
): Result {
    return scope.run(source, action);
}

/**
 * Runs a producer that later requests may join (a deduplicated summary or topology load) at foreground priority. Its
 * class would otherwise be fixed by whichever caller started it, so a `session.select` joining a load a poll had begun
 * would wait behind the background cap exactly when the machine is busy. Background drivers are still throttled by
 * skipping rounds; only the shared work they start is promoted.
 */
export function runAsSharedWork<Result>(action: () => Result): Result {
    return scope.exit(action);
}

/**
 * The background driver whose async context the caller runs in, or nothing for foreground work.
 */
export function currentBackgroundWork(): BackgroundWorkSource | undefined {
    return scope.getStore();
}

/**
 * Starts fire-and-forget background work, or records it as deferred when the machine is loaded. For drivers that a
 * later poll or event retries anyway, so skipping one round loses nothing.
 */
export function runBackgroundUnlessLoaded(
    source: BackgroundWorkSource,
    action: () => Promise<unknown>,
    load: BackgroundLoadGate = machineLoad,
): void {
    if (load.shouldDefer(source)) return;
    // Fire-and-forget: the caller's action owns its failure reporting.
    void runAsBackgroundWork(source, action);
}
