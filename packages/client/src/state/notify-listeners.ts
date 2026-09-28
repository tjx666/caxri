/**
 * Invokes every listener in `listeners` with `value`, isolating each call so a listener that throws cannot prevent
 * later listeners in the same set from observing this value. Delivery to the survivors still happens exactly once per
 * value.
 *
 * This matters most for a fan-out that sits downstream of a cursor or journal (for example
 * `createRecoveringEventClient`'s `emit` callback): the upstream layer already considers the value delivered once
 * fan-out starts, so an exception bubbling out here would both stop remaining listeners and make the value
 * unrecoverable on retry (the cursor has already advanced past it).
 *
 * @param listeners - Listeners to notify, in iteration order.
 * @param value - Value delivered to every listener.
 * @param onListenerError - Reports one listener's failure. Receives only the thrown error, never `value`, so a caller
 *   cannot accidentally log a payload that diagnostics must exclude (for example Terminal output or transcripts carried
 *   on a Server event).
 */
export function notifyListeners<T>(
    listeners: Iterable<(value: T) => void>,
    value: T,
    onListenerError?: (error: unknown) => void,
): void {
    for (const listener of listeners) {
        try {
            listener(value);
        } catch (error) {
            onListenerError?.(error);
        }
    }
}

/**
 * Delivers `value` to every listener like {@link notifyListeners}, then rethrows the first listener failure.
 *
 * Use this where the caller already owns a failure path for a throwing delivery (for example the supervise client's
 * `receive` closes the transport). Isolation keeps a throwing listener from starving later ones; the rethrow keeps that
 * caller's failure path instead of turning the error into an uncaught exception or silently swallowing it.
 */
export function notifyListenersThenRethrow<T>(
    listeners: Iterable<(value: T) => void>,
    value: T,
): void {
    let failure: { error: unknown } | undefined;
    notifyListeners(listeners, value, (error) => {
        failure ??= { error };
    });
    if (failure) throw failure.error;
}
