export interface TooltipCursorPoint {
    x: number;
    y: number;
}

export interface TooltipCursorAnchor {
    getBoundingClientRect(): DOMRect;
}

export const TOOLTIP_CURSOR_SIDE_OFFSET = 10;
/**
 * Includes a one-pixel guard so fractional popup widths retain at least eight painted CSS pixels of clearance.
 */
export const TOOLTIP_CURSOR_COLLISION_PADDING = 9;

/**
 * Captures a zero-size virtual anchor once when a pointer opens a tooltip. The returned rectangle owns a copy of the
 * coordinates, so later pointer movement cannot make an already-open tooltip jitter.
 */
export function resolveTooltipCursorAnchor(
    isOpen: boolean,
    reason: string,
    point: TooltipCursorPoint | undefined,
): TooltipCursorAnchor | undefined {
    if (!isOpen || reason !== 'trigger-hover' || !point) return;
    const x = point.x;
    const y = point.y;
    const rectangle: DOMRect = {
        bottom: y,
        height: 0,
        left: x,
        right: x,
        top: y,
        width: 0,
        x,
        y,
        toJSON: () => ({ bottom: y, height: 0, left: x, right: x, top: y, width: 0, x, y }),
    };
    return { getBoundingClientRect: () => rectangle };
}

/**
 * How long the pointer rests on a trigger before any shared Tooltip opens (Base UI `delay`).
 *
 * Matches VS Code's macOS default for `workbench.hover.delay` (1500 ms; 500 ms on Windows and Linux), which it chose to
 * track native macOS hovers. 500 ms popped a tooltip over a file tree row the pointer was only passing through.
 */
export const TOOLTIP_OPEN_DELAY_MS = 1500;

/**
 * Absorbs timer jitter between the pointer-enter timestamp and Base UI's own rest timer, which starts on the
 * `mouseenter` that follows it.
 */
const TOOLTIP_REST_TOLERANCE_MS = 20;

/**
 * Milliseconds a cursor-anchored tooltip must still wait before it may open, or `0` once the pointer has rested on its
 * trigger for the full delay.
 *
 * Base UI opens a tooltip instantly while its delay group is warm or while a sibling trigger's popup is open or still
 * closing. That suits toolbar buttons, but sweeping through tree rows then flashes a tooltip on every row. VS Code
 * keeps its `'mouse'` placement hovers (Explorer rows) out of `instantHover`, so a row tooltip waits for each row.
 */
export function resolveCursorTooltipRestRemaining(
    enteredAt: number | undefined,
    now: number,
): number {
    if (enteredAt === undefined) return 0;
    const remaining = TOOLTIP_OPEN_DELAY_MS - (now - enteredAt);
    return remaining > TOOLTIP_REST_TOLERANCE_MS ? remaining : 0;
}
