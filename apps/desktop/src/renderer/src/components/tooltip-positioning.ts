export interface TooltipCursorPoint {
    x: number;
    y: number;
}

export interface TooltipCursorAnchor {
    getBoundingClientRect(): DOMRect;
}

const TOOLTIP_CURSOR_INLINE_OFFSET = 10;

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
    const x = point.x + TOOLTIP_CURSOR_INLINE_OFFSET;
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
