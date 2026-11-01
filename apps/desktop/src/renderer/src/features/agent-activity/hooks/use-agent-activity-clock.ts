import { useSyncExternalStore } from 'react';

import { RELATIVE_TIME_TICK_MS, subscribeToRelativeTimeClock } from '@/hooks/use-relative-time';

/**
 * `now` for the retention window, quantized to the shared relative-time tick.
 *
 * Quantizing is what makes this a stable snapshot: `useSyncExternalStore` compares snapshots by identity, so returning
 * a raw `Date.now()` would re-render on every read. Sharing the relative-time clock rather than starting a second
 * interval also keeps a row's "12m ago" and the window that label is about turning over in the same tick.
 *
 * The subscription needs no visibility gate. The Activity queue is mounted only while the Primary Side Bar is showing
 * it, so hiding the queue stops this clock by unmounting its only consumer.
 */
function getSnapshot(): number {
    return Math.floor(Date.now() / RELATIVE_TIME_TICK_MS) * RELATIVE_TIME_TICK_MS;
}

export function useAgentActivityClock(): number {
    return useSyncExternalStore(subscribeToRelativeTimeClock, getSnapshot);
}
