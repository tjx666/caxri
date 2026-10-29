/**
 * Wall-clock budget for one `adb shell input swipe` fling that asks Android for a 120 ms gesture. A healthy host
 * finishes in a few hundred milliseconds; beyond this the host was too loaded to deliver the touch events on time.
 */
export const FLING_INJECTION_BUDGET_MS = 1000;

/**
 * Most fling attempts per measurement slot before the run is reported as an invalid environment.
 */
export const FLING_MAX_ATTEMPTS = 4;

export interface FlingAttempt {
    injectMs: number;
    /**
     * `valid` attempts are judged against the product assertion; `host-overloaded` attempts are discarded because
     * Android derives fling velocity from event timestamps, so a delayed injection yields a much slower gesture
     * (#1463).
     */
    verdict: 'host-overloaded' | 'valid';
}

export function classifyFlingInjection(injectMs: number): FlingAttempt['verdict'] {
    return injectMs > FLING_INJECTION_BUDGET_MS ? 'host-overloaded' : 'valid';
}
