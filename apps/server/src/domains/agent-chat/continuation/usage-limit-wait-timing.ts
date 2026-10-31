/**
 * How often waits are checked. A continuation lands at most this long after its stagger ends.
 */
export const SWEEP_INTERVAL_MS = 15_000;

/**
 * A wait that comes due this long after its time (the Mac slept through the reset, or Server Core was not running) does
 * not continue on its own: the user may have moved on, so the notice offers Continue instead. Claude Code asks the same
 * after a long sleep.
 */
export const MISSED_AFTER_MS = 30 * 60_000;

/**
 * The stagger after a reset before a Chat continues, so Chats that hit the same limit do not all start at its first
 * second, when a provider may still count the old window.
 */
const MIN_STAGGER_MS = 30_000;
const MAX_STAGGER_MS = 120_000;

/**
 * The stagger for one Chat, from a `random` value in [0, 1).
 */
export function usageLimitWaitStagger(random: number): number {
    return MIN_STAGGER_MS + Math.round(random * (MAX_STAGGER_MS - MIN_STAGGER_MS));
}
