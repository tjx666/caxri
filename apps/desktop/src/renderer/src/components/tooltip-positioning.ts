export interface TooltipCursorPoint {
    x: number;
    y: number;
}

export interface TooltipCursorAnchor {
    getBoundingClientRect(): DOMRect;
}

const TOOLTIP_CURSOR_INLINE_OFFSET = 10;
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
    viewportWidth?: number,
): TooltipCursorAnchor | undefined {
    if (!isOpen || reason !== 'trigger-hover' || !point) return;
    /**
     * A virtual anchor outside the viewport makes Floating UI's initial alignment flip end at that off-screen anchor
     * before the cursor-specific shift middleware settles. Clamp the zero-width anchor itself so the first painted
     * frame observes the same collision padding as every later positioning pass.
     */
    const maximumX = viewportWidth
        ? Math.max(
              TOOLTIP_CURSOR_COLLISION_PADDING,
              viewportWidth - TOOLTIP_CURSOR_COLLISION_PADDING,
          )
        : Infinity;
    const x = Math.min(point.x + TOOLTIP_CURSOR_INLINE_OFFSET, maximumX);
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
