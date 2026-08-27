import { useEffect, useState } from 'react';

/**
 * Returns `value` once it has stayed unchanged for `delayMs`, deferring rapid intermediate updates.
 *
 * Shared Renderer hooks live in `@/hooks`; add cross-feature hooks here instead of redefining them inside a feature.
 * Non-React pure helpers belong in `es-toolkit` or `@caxri/utils` instead.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delayMs);
        return () => clearTimeout(timer);
    }, [delayMs, value]);
    return debounced;
}
