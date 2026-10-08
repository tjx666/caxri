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

/**
 * Anything a cleanup fan-out can release: an object with `dispose()` (Monaco, xterm, and Extension API subscriptions)
 * or a bare teardown callback (for example the remover a subscribe function returns).
 */
export type DisposableTarget = (() => void) | { dispose(): void };

/**
 * Releases every entry in `disposables`, isolating each one so a `dispose()` that throws cannot leak the subscriptions
 * after it. Monaco's `Emitter` throws `Attempted to dispose unknown listener` on a repeated dispose, and an Extension
 * API teardown is arbitrary third-party code, so a bare `for (const d of xs) d.dispose()` loop can stop half way.
 *
 * @param disposables - Entries to release, in iteration order.
 * @param onDisposeError - Reports one entry's failure. Omit only where the failure is genuinely unactionable.
 */
export function disposeAll(
    disposables: Iterable<DisposableTarget>,
    onDisposeError?: (error: unknown) => void,
): void {
    for (const disposable of disposables) {
        try {
            if (typeof disposable === 'function') disposable();
            else disposable.dispose();
        } catch (error) {
            onDisposeError?.(error);
        }
    }
}

/**
 * Releases every entry like {@link disposeAll}, then rethrows the first failure, matching
 * {@link notifyListenersThenRethrow}. Isolation guarantees the later entries are still released; the rethrow keeps the
 * failure visible to the caller (or the global error handler) instead of silently swallowing it.
 */
export function disposeAllThenRethrow(disposables: Iterable<DisposableTarget>): void {
    let failure: { error: unknown } | undefined;
    disposeAll(disposables, (error) => {
        failure ??= { error };
    });
    if (failure) throw failure.error;
}
