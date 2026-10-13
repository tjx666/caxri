/**
 * How long a loading placeholder waits before drawing its shapes. Local work (a file read, a lazy chunk, an IPC read
 * against an idle Server) settles well inside this window, and a skeleton that appears and vanishes a moment later
 * reads as a flicker rather than as progress. 500ms matches `spin-delay`'s default
 * (https://github.com/smeijer/spin-delay) and sits under the one-second limit below which a wait needs no feedback
 * (https://www.nngroup.com/articles/response-times-3-important-limits/); VS Code waits even longer (800ms) before its
 * editor progress bar.
 */
export const LOADING_SKELETON_DELAY_MS = 500;

/**
 * The longest gap between one placeholder unmounting and the next mounting in the same scope that still counts as one
 * continuous wait. A file read handing over to the editor module load, or a tree root handing over to its first
 * expanded branch, swaps placeholders within a commit or two; an unrelated later load starts long after.
 */
export const LOADING_SKELETON_HANDOFF_MS = 100;

/**
 * The wait one surface (an editor pane, a tree view) is in. Placeholders in that surface share it, so a chain of them
 * reads as one wait: without it each new placeholder restarted the delay, and a wait that had already drawn its
 * skeleton went blank before drawing it again.
 */
export interface LoadingSkeletonClock {
    /**
     * When the current wait began, in `performance.now()` time; unset before the first placeholder.
     */
    startedAt?: number;
    /**
     * When the last placeholder of the wait unmounted; unset while one is mounted.
     */
    endedAt?: number;
    mounted: number;
}

export function createLoadingSkeletonClock(): LoadingSkeletonClock {
    return { mounted: 0 };
}

/**
 * Registers a mounting placeholder and returns when its wait began: the scope's ongoing wait when one is mounted or
 * just handed over, otherwise `now`.
 */
export function claimLoadingSkeletonClock(clock: LoadingSkeletonClock, now: number): number {
    const isContinuing =
        clock.startedAt !== undefined &&
        (clock.mounted > 0 ||
            (clock.endedAt !== undefined && now - clock.endedAt <= LOADING_SKELETON_HANDOFF_MS));
    if (!isContinuing) clock.startedAt = now;
    clock.mounted += 1;
    clock.endedAt = undefined;
    return clock.startedAt ?? now;
}

export function releaseLoadingSkeletonClock(clock: LoadingSkeletonClock, now: number): void {
    clock.mounted = Math.max(0, clock.mounted - 1);
    if (clock.mounted === 0) clock.endedAt = now;
}

/**
 * Zero means the wait is already past the delay, so the placeholder draws its shapes in its first frame.
 */
export function remainingLoadingSkeletonDelay(
    startedAt: number,
    now: number,
    delayMs: number = LOADING_SKELETON_DELAY_MS,
): number {
    return Math.max(0, delayMs - (now - startedAt));
}

interface RevealTimers {
    set: (callback: () => void, delayMs: number) => unknown;
    clear: (handle: unknown) => void;
}

const browserTimers: RevealTimers = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Calls `reveal` once the delay has passed and returns the cancel function, so an effect can return it directly and a
 * placeholder unmounted before the delay never reveals.
 */
export function scheduleLoadingSkeletonReveal(
    reveal: () => void,
    timers: RevealTimers = browserTimers,
    delayMs: number = LOADING_SKELETON_DELAY_MS,
): () => void {
    const handle = timers.set(reveal, delayMs);
    return () => timers.clear(handle);
}
