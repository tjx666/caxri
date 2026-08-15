/**
 * Pure decision logic for recovering from a crashed Renderer (`render-process-gone`). Kept free of `Date.now()` and
 * `setTimeout` so it can be unit tested with injected timestamps and so the Electron wiring in `index.ts` stays a thin
 * caller.
 */

/**
 * Sliding window used to decide whether the Renderer is crash-looping.
 */
const CRASH_WINDOW_MS = 60_000;
/**
 * Exponential reload backoff: 250ms, then 1s, then 4s, matching the WP4 review requirement.
 */
const RELOAD_BACKOFF_MS = [250, 1_000, 4_000] as const;

interface CrashRecoveryDecision {
    /**
     * `reload` retries automatically after `delayMs`; `stop` gives up and asks the user.
     */
    action: 'reload' | 'stop';
    /**
     * Present only when `action` is `'reload'`.
     */
    delayMs?: number;
    /**
     * Number of crashes counted within the current window, including this one.
     */
    crashCount: number;
}

export interface CrashRecoveryResult {
    decision: CrashRecoveryDecision;
    /**
     * Updated crash history to persist and pass into the next call.
     */
    crashTimestampsMs: number[];
}

/**
 * Decides whether a Renderer crash should trigger an automatic reload or stop the loop.
 *
 * @param previousCrashTimestampsMs Crash timestamps recorded so far, oldest first.
 * @param nowMs Timestamp of the crash being decided, injected by the caller instead of read here.
 */
export function decideCrashRecovery(
    previousCrashTimestampsMs: readonly number[],
    nowMs: number,
): CrashRecoveryResult {
    const withinWindow = previousCrashTimestampsMs.filter((ts) => nowMs - ts < CRASH_WINDOW_MS);
    const crashTimestampsMs = [...withinWindow, nowMs];
    const crashCount = crashTimestampsMs.length;
    if (crashCount > RELOAD_BACKOFF_MS.length) {
        return { decision: { action: 'stop', crashCount }, crashTimestampsMs };
    }
    return {
        decision: {
            action: 'reload',
            delayMs: RELOAD_BACKOFF_MS[crashCount - 1],
            crashCount,
        },
        crashTimestampsMs,
    };
}
