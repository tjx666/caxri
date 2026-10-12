import { useRef, useSyncExternalStore } from 'react';

import type { RelativeTimeStyle } from '@caxri/utils';
import { notifyListeners } from '@caxri/utils';

import { useTranslation } from '../i18n';
import { localizedRelativeTime } from '../lib/relative-time';

/**
 * How often every relative-time label on screen is re-checked. Half a minute is the coarsest cadence that still turns
 * "59 seconds ago" over on time.
 */
export const RELATIVE_TIME_TICK_MS = 30_000;

const listeners = new Set<() => void>();
const clock: { timer?: ReturnType<typeof setInterval> } = {};

/**
 * One interval for the whole window, started with the first label and stopped with the last. Each subscriber used to
 * own a `setInterval`, so five Session cards meant five timers firing at five unrelated phases.
 *
 * Exported so anything else on the same half-minute cadence shares this timer instead of starting a second one at its
 * own phase: `useAgentActivityClock` does, which is what keeps a row's "12 minutes ago" and the retention window it
 * describes turning over together rather than up to 30 seconds apart.
 */
export function subscribeToRelativeTimeClock(listener: () => void): () => void {
    listeners.add(listener);
    clock.timer ??= setInterval(() => {
        // Isolates each tick subscriber so one throwing label cannot stop the window's other relative-time labels from
        // turning over on this shared timer; Desktop mirrors `console.error` into `logs/desktop.jsonl`.
        notifyListeners(listeners, undefined, (error) =>
            console.error('relativeTime.tick listener failed', error),
        );
    }, RELATIVE_TIME_TICK_MS);
    return () => {
        listeners.delete(listener);
        if (clock.timer !== undefined && listeners.size === 0) {
            clearInterval(clock.timer);
            clock.timer = undefined;
        }
    };
}

/**
 * Which of the two values a tick should publish: the one already on screen whenever the freshly computed one means the
 * same thing, and the new one otherwise.
 *
 * This is the whole point of the module. A hook that handed out `Date.now()` re-rendered its caller on every tick,
 * forever, because the number always changes, while the thing on screen, "3 hours ago", changed a few times a day.
 * Comparing the rendered value instead means a tick reaches React only when the label it produces is actually
 * different. Returning the _previous_ reference rather than an equal copy is load-bearing: `useSyncExternalStore`
 * compares snapshots by identity, so an equal-but-new array would re-render anyway.
 */
export function nextTickedValue<T>(
    previous: { value: T } | undefined,
    next: T,
    isEqual: (a: T, b: T) => boolean,
): T {
    return previous && isEqual(previous.value, next) ? previous.value : next;
}

/**
 * Two label lists mean the same thing when they are the same length and every position reads the same. Used instead of
 * identity because the list is rebuilt from the clock on every tick.
 */
export function areLabelsEqual(
    a: ReadonlyArray<string | undefined>,
    b: ReadonlyArray<string | undefined>,
): boolean {
    return a.length === b.length && a.every((label, index) => label === b[index]);
}

/**
 * Subscribes to the shared clock and returns `compute()`'s value, keeping the previous one whenever the new one means
 * the same thing (see {@link nextTickedValue}).
 *
 * `compute` reads the real clock rather than a stored tick, so a label mounted between two ticks is correct immediately
 * instead of showing the previous tick's answer for up to half a minute.
 */
function useTickedValue<T>(compute: () => T, isEqual: (a: T, b: T) => boolean): T {
    const cache = useRef<{ value: T }>(undefined);
    return useSyncExternalStore(subscribeToRelativeTimeClock, () => {
        const value = nextTickedValue(cache.current, compute(), isEqual);
        cache.current = { value };
        return value;
    });
}

/**
 * A live "3 minutes ago" label for one timestamp, re-rendering the caller only when the wording changes. `undefined`
 * in, `undefined` out, so a caller whose timestamp arrives with a query can still call this unconditionally.
 *
 * `style` picks how much width the label may spend; a dense side-bar row passes `narrow` for "3m ago".
 */
export function useRelativeTime(timestamp: number, style?: RelativeTimeStyle): string;
export function useRelativeTime(
    timestamp: number | undefined,
    style?: RelativeTimeStyle,
): string | undefined;
export function useRelativeTime(
    timestamp: number | undefined,
    style: RelativeTimeStyle = 'long',
): string | undefined {
    // The locale is read on every render, so a language change relabels the caller without waiting for a tick.
    const { locale } = useTranslation();
    return useTickedValue(
        () =>
            timestamp === undefined
                ? undefined
                : localizedRelativeTime(timestamp, Date.now(), style, locale),
        Object.is,
    );
}

/**
 * The same thing for a list, index-aligned with the timestamps given. One subscription per list rather than per row,
 * and the caller re-renders when any one of its labels changes, which is the right granularity for a list that is
 * rendered by a single component anyway.
 *
 * `style` picks how much width the labels may spend; a dense side-bar row passes `narrow` for "8m ago".
 */
export function useRelativeTimes(
    timestamps: readonly number[],
    style?: RelativeTimeStyle,
): readonly string[];
export function useRelativeTimes(
    timestamps: ReadonlyArray<number | undefined>,
    style?: RelativeTimeStyle,
): ReadonlyArray<string | undefined>;
export function useRelativeTimes(
    timestamps: ReadonlyArray<number | undefined>,
    style: RelativeTimeStyle = 'long',
): ReadonlyArray<string | undefined> {
    const { locale } = useTranslation();
    return useTickedValue(
        () =>
            timestamps.map((timestamp) =>
                timestamp === undefined
                    ? undefined
                    : localizedRelativeTime(timestamp, Date.now(), style, locale),
            ),
        areLabelsEqual,
    );
}
