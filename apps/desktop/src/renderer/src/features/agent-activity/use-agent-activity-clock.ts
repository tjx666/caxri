import { useSyncExternalStore } from 'react';

import { RELATIVE_TIME_TICK_MS, subscribeToRelativeTimeClock } from '@/hooks/use-relative-time';

import { useIsViewContainerActive } from '../view-containers/view-container-activity';

/**
 * A never-firing subscription, used while the container is hidden.
 *
 * View containers stay mounted once shown, so without this gate the Activity list would keep re-projecting every
 * Session on a timer the user cannot see the result of. Nothing in Server state changes when the retention window
 * closes, so there is nothing to miss: the first render after the container becomes visible reads the real clock
 * again.
 */
function subscribeIdle(): () => void {
    return () => {};
}

/**
 * `now` for the retention window, quantized to the shared relative-time tick.
 *
 * Quantizing is what makes this a stable snapshot: `useSyncExternalStore` compares snapshots by identity, so returning
 * a raw `Date.now()` would re-render on every read. Sharing the relative-time clock rather than starting a second
 * interval also keeps a row's "12 minutes ago" and the window that label is about turning over in the same tick.
 */
function getSnapshot(): number {
    return Math.floor(Date.now() / RELATIVE_TIME_TICK_MS) * RELATIVE_TIME_TICK_MS;
}

export function useAgentActivityClock(): number {
    const isActive = useIsViewContainerActive();
    return useSyncExternalStore(
        isActive ? subscribeToRelativeTimeClock : subscribeIdle,
        getSnapshot,
    );
}
