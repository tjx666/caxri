/**
 * Puts every Session status ring of one kind on a shared rotation phase.
 *
 * A CSS animation starts when its element first gets the animation style, so two running rings mounted half a second
 * apart keep turning half a turn apart for as long as both are shown (#2575). VS Code's loading icons in one column
 * turn together; these rings should too. Instead of driving the angle from JavaScript (a per-frame transform would put
 * the spin back on the main thread, which #2503 moved off it), each ring keeps its CSS animation and only its start
 * time moves to the last whole-period boundary on the document timeline. Rings of the same period then show the same
 * angle at any moment, a newly mounted ring appears at that angle instead of at 0°, and the compositor still runs it.
 * Rings with different periods (the running arc and the slower background ring) each stay in step with their own kind.
 *
 * @see https://github.com/tjx666/caxri/issues/2575
 */

/**
 * Below this distance from a period boundary a start time already counts as aligned, absorbing float rounding.
 */
const PHASE_TOLERANCE_MS = 0.5;

/**
 * The start time that puts an animation of `period` on the shared phase: the latest whole multiple of `period` at or
 * before `timelineTime`. Every animation started at any such multiple shows the same angle at the same moment.
 *
 * @param timelineTime The document timeline's current time in milliseconds.
 * @param period One iteration's duration in milliseconds.
 * @returns The aligned start time, or `null` when either input cannot define a phase.
 */
export function sharedPhaseStartTime(timelineTime: number, period: number): number | null {
    if (!Number.isFinite(timelineTime) || !Number.isFinite(period) || period <= 0) return null;
    return Math.floor(timelineTime / period) * period;
}

/**
 * Whether `startTime` already sits on a whole-period boundary, so re-aligning it would not change the visible angle.
 *
 * @param startTime The animation's resolved start time in milliseconds.
 * @param period One iteration's duration in milliseconds.
 */
export function isOnSharedPhase(startTime: number, period: number): boolean {
    const offset = ((startTime % period) + period) % period;
    return offset < PHASE_TOLERANCE_MS || period - offset < PHASE_TOLERANCE_MS;
}

/**
 * Moves each of the element's animations onto its period's shared phase, leaving already aligned ones untouched.
 */
function joinSharedSpinPhase(element: Element): void {
    for (const animation of element.getAnimations()) {
        const timelineTime = animation.timeline?.currentTime;
        const period = animation.effect?.getComputedTiming().duration;
        if (typeof timelineTime !== 'number' || typeof period !== 'number') continue;
        const startTime = sharedPhaseStartTime(timelineTime, period);
        if (startTime === null) continue;
        const current = animation.startTime;
        if (typeof current === 'number' && isOnSharedPhase(current, period)) continue;
        animation.startTime = startTime;
    }
}

/**
 * Ref callback for a spinning status ring. Aligning in the ref runs before the ring's first paint, so it never shows a
 * frame at its own phase. Reduced motion has no animation to align; when the user turns motion back on, the browser
 * creates a fresh animation and `animationstart` aligns that one too. Module-level so React never re-attaches it.
 */
export function syncSpinPhase(element: HTMLElement | null): (() => void) | undefined {
    if (!element) return undefined;
    joinSharedSpinPhase(element);
    const realign = (): void => joinSharedSpinPhase(element);
    element.addEventListener('animationstart', realign);
    return () => element.removeEventListener('animationstart', realign);
}
