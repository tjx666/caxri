import { useSyncExternalStore } from 'react';

const TICK_MS = 1000;

function subscribeToSecondTick(onTick: () => void): () => void {
    const timer = setInterval(onTick, TICK_MS);
    return () => clearInterval(timer);
}

/**
 * `now` quantized to whole seconds, so the snapshot is stable between ticks.
 */
function getSecondSnapshot(): number {
    return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

/**
 * The current time, refreshed once a second, for a ticking elapsed-time label. Only the component that calls it
 * re-renders each second, and the clock runs only while such a component is mounted, so mount it in the smallest leaf
 * that shows the time.
 */
export function useSecondTick(): number {
    return useSyncExternalStore(subscribeToSecondTick, getSecondSnapshot);
}
