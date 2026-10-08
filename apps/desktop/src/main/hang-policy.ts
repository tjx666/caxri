/**
 * Pure bookkeeping for a hung Renderer (`unresponsive`/`responsive`). Kept free of `Date.now()` and `setTimeout` so it
 * can be unit tested with injected timestamps and so the Electron wiring stays a thin caller, matching
 * `crash-policy.ts`.
 *
 * A hang is not a crash: Chromium fires `unresponsive` when the Renderer's main thread has been blocked past its own
 * ~30s threshold, and `responsive` when it recovers. Recording only the entry would leave an outcome without its
 * duration, and recording every repeat would make the real volume unknowable, so the entry carries a per-window
 * lifetime count and the exit carries how long the window was blocked.
 */

export interface HangState {
    /**
     * Timestamp of the hang currently in progress, or `undefined` while the window is responsive.
     */
    startedAtMs?: number;
    /**
     * Hangs observed for this window's lifetime, including the one in progress.
     */
    hangCount: number;
}

export const initialHangState: HangState = { hangCount: 0 };

export interface HangStartResult {
    /**
     * Absent when the window was already hung: Chromium can re-fire `unresponsive` for one continuous block, and
     * counting those repeats would inflate the aggregate past the number of real hangs.
     */
    record?: { hangCount: number };
    state: HangState;
}

export interface HangEndResult {
    /**
     * Absent when no hang was in progress, so a `responsive` event without a matching `unresponsive` records nothing
     * rather than a zero-length hang.
     */
    record?: { hangCount: number; durationMs: number };
    state: HangState;
}

/**
 * @param previous Hang state carried forward from this window's last transition.
 * @param nowMs Timestamp of the `unresponsive` event, injected by the caller instead of read here.
 */
export function beginHang(previous: HangState, nowMs: number): HangStartResult {
    if (previous.startedAtMs !== undefined) return { state: previous };
    const hangCount = previous.hangCount + 1;
    return { record: { hangCount }, state: { startedAtMs: nowMs, hangCount } };
}

/**
 * Closes the hang in progress, whether the window recovered or its Renderer process died under it. Both are the same
 * bookkeeping (the block is over and its duration is known), so the caller distinguishes them in the record it writes
 * rather than here. The lifetime count is deliberately kept across a crash: it belongs to the window, not to the
 * process that was serving it.
 *
 * @param previous Hang state carried forward from this window's last transition.
 * @param nowMs Timestamp of the event that ended it, injected by the caller instead of read here.
 */
export function endHang(previous: HangState, nowMs: number): HangEndResult {
    if (previous.startedAtMs === undefined) return { state: previous };
    return {
        record: {
            hangCount: previous.hangCount,
            durationMs: Math.max(0, nowMs - previous.startedAtMs),
        },
        state: { hangCount: previous.hangCount },
    };
}
