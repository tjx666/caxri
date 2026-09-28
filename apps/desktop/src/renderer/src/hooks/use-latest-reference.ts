import { useLayoutEffect, useRef } from 'react';

/**
 * Keeps a ref in sync with the latest render's value, for reading current props/state from a stable imperative callback
 * (e.g. an event handler captured once by a mount effect) without retriggering that effect on every change. No
 * dependency array: the sync effect intentionally runs after every render so the ref is never stale.
 *
 * A layout effect rather than a passive one: it runs in the same commit as the DOM update, so an event that reaches a
 * stable handler right after a render already reads that render's value. A passive effect leaves a window between the
 * commit and the effect flush in which the handler would act on the previous render's list.
 */
export function useLatestReference<T>(value: T): { readonly current: T } {
    const reference = useRef(value);
    useLayoutEffect(() => {
        reference.current = value;
    });
    return reference;
}
