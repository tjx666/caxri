import parcelWatcher from '@parcel/watcher';

import { WatchHub } from '../../domains/watch-hub';

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
