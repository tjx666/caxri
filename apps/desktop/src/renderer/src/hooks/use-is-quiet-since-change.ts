import { useEffect, useState } from 'react';

/**
 * Reports not quiet now and quiet again once `quietMs` passes. Returns the cleanup that cancels the pending report, so
 * a newer change restarts the window instead of letting an older one end it.
 */
export function startQuietWindow(quietMs: number, report: (isQuiet: boolean) => void): () => void {
    report(false);
    const timer = setTimeout(() => report(true), quietMs);
    return () => clearTimeout(timer);
}

/**
 * A value with the verdict for the change that produced it: whether the value had been quiet before that change.
 */
export interface QuietChange<T> {
    value: T;
    isQuiet: boolean;
}

/**
 * Keeps the verdict while `value` holds and decides it afresh from `isQuiet` when the value moves.
 */
export function nextQuietChange<T>(
    previous: QuietChange<T>,
    value: T,
    isQuiet: boolean,
): QuietChange<T> {
    return Object.is(previous.value, value) ? previous : { value, isQuiet };
}

/**
 * Whether `value` had stayed unchanged for at least `quietMs` before its latest change. Used to animate only
 * slow-moving figures: a count that ticks every second or climbs while a reply streams would otherwise never stop
 * moving.
 *
 * The verdict is fixed when the value changes and holds until the next change. The quiet window restarting right after
 * a change must not flip it: NumberFlow finishes every running animation the moment its `animated` property changes,
 * which would cut the roll that change just started.
 */
export function useIsQuietSinceChange<T>(value: T, quietMs: number): boolean {
    const [isQuiet, setIsQuiet] = useState(true);
    const [change, setChange] = useState<QuietChange<T>>({ value, isQuiet: true });
    const next = nextQuietChange(change, value, isQuiet);
    // Adjusting state while rendering, as React documents for state derived from a changed prop, so the new value and
    // its verdict reach NumberFlow in the same commit.
    if (next !== change) setChange(next);
    useEffect(() => startQuietWindow(quietMs, setIsQuiet), [quietMs, value]);
    return next.isQuiet;
}
