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
        snapshot: (): number => clockTickSnapshot(intervalMs, Date.now()),
    };
}

/**
 * `now` rounded down to the clock's interval, so every read inside one tick returns the same value.
 */
export function clockTickSnapshot(intervalMs: number, now: number): number {
    return Math.floor(now / intervalMs) * intervalMs;
}

/**
 * The subscription of a clock nobody is watching: no timer, so the component never re-renders on a tick.
 */
function subscribeNothing(): () => void {
    return () => {};
}

const CLOCKS = { second: clock(1000), minute: clock(60_000) };

/**
 * The current time, refreshed once per `unit`: a second for a ticking elapsed-time label, a minute for a notice that
 * depends on minutes passing, such as an expiring cache. Only the component that calls it re-renders each tick, and the
 * clock runs only while such a component is mounted, so mount it in the smallest leaf that shows the time. Pass
 * `isActive = false` for a component that is mounted but hidden (a kept-alive Chat): it subscribes to nothing, and
 * reads the current time again when it becomes active.
 */
export function useClockTick(unit: keyof typeof CLOCKS, isActive = true): number {
    const { subscribe, snapshot } = CLOCKS[unit];
    return useSyncExternalStore(isActive ? subscribe : subscribeNothing, snapshot);
}
