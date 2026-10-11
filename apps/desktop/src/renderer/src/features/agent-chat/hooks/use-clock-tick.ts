import { useSyncExternalStore } from 'react';

/**
 * A clock that ticks every `intervalMs` while a component reads it. The snapshot is `now` quantized to the interval, so
 * it stays stable between ticks.
 */
function clock(intervalMs: number) {
    return {
        subscribe: (onTick: () => void): (() => void) => {
            const timer = setInterval(onTick, intervalMs);
            return () => clearInterval(timer);
        },
        snapshot: (): number => Math.floor(Date.now() / intervalMs) * intervalMs,
    };
}

const CLOCKS = { second: clock(1000), minute: clock(60_000) };

/**
 * The current time, refreshed once per `unit`: a second for a ticking elapsed-time label, a minute for a notice that
 * depends on minutes passing, such as an expiring cache. Only the component that calls it re-renders each tick, and the
 * clock runs only while such a component is mounted, so mount it in the smallest leaf that shows the time.
 */
export function useClockTick(unit: keyof typeof CLOCKS): number {
    const { subscribe, snapshot } = CLOCKS[unit];
    return useSyncExternalStore(subscribe, snapshot);
}
