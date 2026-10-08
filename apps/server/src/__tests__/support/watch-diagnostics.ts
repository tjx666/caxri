import parcelWatcher from '@parcel/watcher';

import { WatchHub } from '../../domains/watch-hub';

const DEFAULT_EVENT_GATE_TIMEOUT_MS = 5_000;

/**
 * Push-based alternative to polling a mutable events array with `expect.poll`/`vi.waitFor`. Both of those resample on a
 * fixed interval, so on a loaded self-hosted runner each tick competes for the same starved event loop the watcher
 * callback itself is waiting on: the polling interval adds its own delay on top of the real watcher/settle latency,
 * which is what turns load into a hard timeout instead of just a slower pass (see issue #1259). Resolving from inside
 * `push` settles a waiting `waitFor` in the same tick the matching event actually arrives, no matter how long the gap
 * to the next scheduled poll tick would have been.
 */
export function createEventGate<T>() {
    const events: T[] = [];
    const waiters = new Set<{ isMatch: (event: T) => boolean; resolve: (event: T) => void }>();
    return {
        events,
        push: (event: T): void => {
            events.push(event);
            for (const waiter of waiters) {
                if (!waiter.isMatch(event)) continue;
                waiters.delete(waiter);
                waiter.resolve(event);
            }
        },
        /**
         * Resolves with the first already-observed or future event matching `isMatch`. Checking history first closes
         * the gap where the event arrived before `waitFor` was called.
         */
        waitFor(
            isMatch: (event: T) => boolean,
            timeoutMs = DEFAULT_EVENT_GATE_TIMEOUT_MS,
        ): Promise<T> {
            const observed = events.find((event) => isMatch(event));
            if (observed !== undefined) return Promise.resolve(observed);
            return new Promise<T>((resolve, reject) => {
                // A boxed reference (rather than a bare `let`) lets `waiter.resolve` cancel the pending timeout
                // without a use-before-define/prefer-const conflict: the box itself is assigned once, its
                // `current` property is filled in after `waiter` is created and captures it by reference.
                const timerBox: { current?: ReturnType<typeof setTimeout> } = {};
                const waiter = {
                    isMatch,
                    resolve: (event: T) => {
                        clearTimeout(timerBox.current);
                        resolve(event);
                    },
                };
                timerBox.current = setTimeout(() => {
                    waiters.delete(waiter);
                    reject(
                        new Error(`Timed out after ${timeoutMs}ms waiting for a matching event`),
                    );
                }, timeoutMs);
                waiters.add(waiter);
            });
        },
    };
}

/**
 * Observes the real backend without changing its options, callbacks, or subscription lifetime.
 */
export function createWatchDiagnosticHub(subscribe = parcelWatcher.subscribe) {
    const nativeCallbacks = { calls: 0, errors: 0, events: 0 };
    const hub = new WatchHub({
        subscribe: (root, callback, options) =>
            subscribe(
                root,
                (error, events) => {
                    nativeCallbacks.calls += 1;
                    if (error) nativeCallbacks.errors += 1;
                    nativeCallbacks.events += events.length;
                    callback(error, events);
                },
                options,
            ),
    });
    return Object.assign(hub, { nativeCallbacks });
}

/**
 * Captures only bounded counters on failure; event batches do not prove a target file changed.
 */
export function createWatchFailureProbe(
    hub: Pick<WatchHub, 'snapshot'> & {
        nativeCallbacks?: { calls: number; errors: number; events: number };
    },
    label: 'config' | 'files-root',
    observedEvents: () => number,
) {
    const before = hub.snapshot().entries.find((entry) => entry.label === label);
    const observedBefore = observedEvents();
    const callbacksBefore = hub.nativeCallbacks && { ...hub.nativeCallbacks };
    return async <T>(assertion: PromiseLike<T>): Promise<T> => {
        try {
            return await assertion;
        } catch (error) {
            const snapshot = hub.snapshot();
            const after = snapshot.entries.find((entry) => entry.label === label);
            const eventBatchesBefore = before?.eventBatches ?? 0;
            const eventBatchesAfter = after?.eventBatches ?? 0;
            const observedDelta = observedEvents() - observedBefore;
            const reason = !after
                ? 'no_registration'
                : observedDelta > 0
                  ? 'observed_event_without_asserted_state'
                  : after.polling > 0
                    ? 'polling_without_outcome'
                    : eventBatchesAfter <= eventBatchesBefore
                      ? 'no_batch_after_write'
                      : 'batch_without_observed_event';
            throw new Error(
                `watcher_diagnostic ${JSON.stringify({
                    label,
                    reason,
                    registrations: snapshot.registrations,
                    native: after?.native ?? 0,
                    polling: after?.polling ?? 0,
                    gateTrips: snapshot.gateTrips,
                    eventBatchesBefore,
                    eventBatchesAfter,
                    eventBatchesDelta: eventBatchesAfter - eventBatchesBefore,
                    observedDelta,
                    ...(callbacksBefore &&
                        hub.nativeCallbacks && {
                            nativeCallbacksDelta: hub.nativeCallbacks.calls - callbacksBefore.calls,
                            nativeErrorCallbacksDelta:
                                hub.nativeCallbacks.errors - callbacksBefore.errors,
                            nativeEventsDelta: hub.nativeCallbacks.events - callbacksBefore.events,
                        }),
                })}`,
                { cause: error },
            );
        }
    };
}
