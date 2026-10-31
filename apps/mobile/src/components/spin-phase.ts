/**
 * One cycle of the shared spin clock. It is a whole multiple of every spin period that reads the clock (the 1 s loading
 * spinner and the 3 s background ring), so each period restarts exactly when the clock wraps and no ring jumps.
 */
export const SPIN_CLOCK_MS = 3_000;

/**
 * The angle a ring of `periodMs` shows at clock progress `progress` (0 to 1 over `SPIN_CLOCK_MS`). Every ring of the
 * same period reads the same clock, so all of them show this one angle at any moment, the way Desktop's `syncSpinPhase`
 * keeps its Session status rings in step (#2575).
 *
 * @param progress The shared clock's progress through one `SPIN_CLOCK_MS` cycle.
 * @param periodMs One turn's duration; must divide `SPIN_CLOCK_MS`.
 * @returns The rotation in degrees, in `[0, 360)`.
 */
export const spinDegrees = (progress: number, periodMs: number): number => {
    'worklet';
    const elapsed = (progress * SPIN_CLOCK_MS) % periodMs;
    return (elapsed / periodMs) * 360;
};
