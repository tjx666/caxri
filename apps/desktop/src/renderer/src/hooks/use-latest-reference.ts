import { useEffect, useRef } from 'react';

/**
 * Keeps a ref in sync with the latest render's value, for reading current props/state from a stable imperative callback
 * (e.g. an event handler captured once by a mount effect) without retriggering that effect on every change. No
 * dependency array: the sync effect intentionally runs after every render so the ref is never stale.
 */
export function useLatestReference<T>(value: T): { readonly current: T } {
    const reference = useRef(value);
    useEffect(() => {
        reference.current = value;
    });
    return reference;
}
