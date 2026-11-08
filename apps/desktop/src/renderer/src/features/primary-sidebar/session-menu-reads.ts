/**
 * Last-known answers for the Server reads that gate the native Session context menu. A native menu cannot be patched
 * once it is showing, and those reads are bounded by a short timeout whose p95 in production is near the limit, so a
 * timeout must not silently flip an entry: it falls back to the value the previous successful read produced.
 */

/**
 * The outcome of one bounded read: the value, or `timedOut` when it failed or did not answer in time.
 */
export type MenuReadResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Small per-Session memory of the last successful read of one kind. Module-level on purpose: the menu is rebuilt on
 * every open, so the memory must outlive it.
 */
export class LastKnownReads<T> {
    private readonly values = new Map<string, T>();

    constructor(private readonly limit = 200) {}

    get(sessionId: string): T | undefined {
        return this.values.get(sessionId);
    }

    set(sessionId: string, value: T): void {
        // Re-insert so the Map's insertion order doubles as recency; drop the oldest past the limit.
        this.values.delete(sessionId);
        this.values.set(sessionId, value);
        if (this.values.size > this.limit) {
            const oldest = this.values.keys().next();
            if (!oldest.done) this.values.delete(oldest.value);
        }
    }
}

/**
 * The value a menu entry should be gated on: the fresh answer when the read finished, otherwise the last-known one,
 * otherwise `fallback` (the value that hides the entry).
 */
export function resolveMenuRead<T>(
    result: MenuReadResult<T>,
    lastKnown: T | undefined,
    fallback: T,
): T {
    if (!result.timedOut) return result.value;
    return lastKnown ?? fallback;
}

/**
 * Which of Hand Over and Take Back the menu offers. An unanswered read with no last-known value shows neither, because
 * guessing wrong offers an action the Server refuses (`already_managed`) or hides the way back.
 */
export function botHandoverEntryKind(
    result: MenuReadResult<boolean>,
    lastKnownManaged: boolean | undefined,
): 'handOver' | 'takeBack' | 'none' {
    const managed = resolveMenuRead<boolean | undefined>(result, lastKnownManaged, undefined);
    if (managed === undefined) return 'none';
    return managed ? 'takeBack' : 'handOver';
}
