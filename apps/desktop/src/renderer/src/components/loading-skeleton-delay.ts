/**
 * How long a loading placeholder waits before drawing its shapes. Local work (a lazy chunk, an IPC read against an idle
 * Server) usually settles well inside this window, and a skeleton that appears and vanishes within a frame or two reads
 * as a flicker rather than as progress. Anything slower still shows the placeholder after a pause too short to notice.
 */
export const LOADING_SKELETON_DELAY_MS = 150;

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
