import { useEffect, useState } from 'react';

/**
 * Returns the current timestamp (epoch milliseconds), re-ticking every `intervalMs`. Drives relative-time labels ("3
 * minutes ago") so they refresh on an interval instead of freezing at the value computed during the initial render —
 * reading `Date.now()` directly inside a render body would violate the render-purity contract (see the `react` skill,
 * section 5).
 */
export function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}
