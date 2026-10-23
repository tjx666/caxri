/**
 * The gap between the selected text and its selection toolbar, and the margin the toolbar keeps inside its surface.
 */
export const SELECTION_TOOLBAR_GAP = 8;

interface Box {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

/**
 * Where a selection toolbar goes, in viewport coordinates: centered above the selection's first line, or below its last
 * line when the surface has no room above, and kept horizontally inside the surface. `undefined` when the selection is
 * scrolled out of the surface, so the toolbar never floats over neighbouring chrome (a Chat's composer, a tab bar).
 */
export function selectionToolbarPosition({
    bounds,
    first,
    last,
    size,
}: {
    /**
     * The visible surface holding the selection: a Chat transcript or an editor.
     */
    bounds: Box;
    /**
     * The selection's first and last line boxes.
     */
    first: Box;
    last: Box;
    size: { width: number; height: number };
}): { top: number; left: number } | undefined {
    if (last.bottom < bounds.top || first.top > bounds.bottom) return undefined;
    const gap = SELECTION_TOOLBAR_GAP;
    const above = first.top - gap - size.height;
    const top =
        above >= bounds.top ? above : Math.min(last.bottom + gap, bounds.bottom - size.height);
    const center = (first.left + first.right) / 2;
    const left = Math.min(
        Math.max(center - size.width / 2, bounds.left + gap),
        bounds.right - gap - size.width,
    );
    return { top, left };
}
