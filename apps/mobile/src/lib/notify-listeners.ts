/**
 * Invokes every listener in `listeners` with `value`, isolating each call so a listener that throws cannot prevent
 * later listeners in the same set from observing this value. Delivery to the survivors still happens exactly once per
 * value.
 *
 * This mirrors `@caxri/utils`'s `notifyListeners`, but `apps/mobile` production code is not allowed to depend on
 * `packages/utils` (see the `mobile` app boundary in `scripts/architecture-boundaries.ts`, which lists `utils` only
 * under `testAllowedPackages`), so this is a small inlined copy instead of a shared import (caxri#1441).
 *
 * @param listeners - Listeners to notify, in iteration order.
 * @param value - Value delivered to every listener.
 */
export function notifyListeners<T>(listeners: Iterable<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
        try {
            listener(value);
        } catch {
            // Isolated and intentionally unreported: Mobile has no structured-log sink yet (caxri#1441).
        }
    }
}
