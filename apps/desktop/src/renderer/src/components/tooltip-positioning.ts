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
