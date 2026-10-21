import { useEffect, useState } from 'react';

/**
 * Whether `key` has stayed the same, and defined, for at least `delayMs`. Turns false the moment the key changes or
 * clears, so a state that comes and goes within moments never shows. For example, a work summary row names its running
 * tool call (keyed by the call's id) only once that call has run for a while.
 */
export function useHasLasted(key: string | undefined, delayMs: number): boolean {
    const [lastedKey, setLastedKey] = useState<string>();
    useEffect(() => {
        if (key === undefined) return;
        const timer = setTimeout(() => setLastedKey(key), delayMs);
        return () => clearTimeout(timer);
    }, [delayMs, key]);
    return key !== undefined && lastedKey === key;
}
