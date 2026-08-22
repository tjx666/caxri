export type PaneDropZone = 'center' | 'down' | 'left' | 'right' | 'up';

/**
 * Drag payload type shared by every pane tab bar and every pane drop target. One type for every tab kind is what keeps
 * drag and drop from branching on what a tab holds. Declared here, beside the drag-type probe, so the probe stays free
 * of the action module's store imports.
 */
export const PANE_TAB_DRAG_TYPE = 'application/x-caxri-pane-tab';

/**
 * `DataTransfer.getData` is empty during `dragenter`/`dragover` in Chromium's protected drag store; only `types` is
 * reliable before `drop`. Preview and accept a drag from the custom pane-tab type only, never from `text/plain` (that
 * would treat selected text as a tab).
 */
export function hasPaneTabDragType(types: readonly string[]): boolean {
    return types.includes(PANE_TAB_DRAG_TYPE);
}

/**
 * Fraction of a pane's width/height, measured from the nearest edge, that counts as an edge drop (split) rather than a
 * center "move into this pane" drop.
 */
const EDGE_DROP_THRESHOLD = 0.25;

/**
 * Geometry only: given a pane's bounding box and a point within it, resolves which of the four edge zones (each
 * `EDGE_DROP_THRESHOLD` of the nearest dimension, measured from that edge) or the remaining center zone the point falls
 * in. Lives outside the view file so the component module only exports components (react-refresh) and the four-edge
 * drop math stays unit-testable without a DOM.
 */
export function resolvePaneDropZone(
    bounds: { height: number; width: number },
    point: { x: number; y: number },
): PaneDropZone {
    if (bounds.width <= 0 || bounds.height <= 0) return 'center';
    const horizontal = point.x / bounds.width;
    const vertical = point.y / bounds.height;
    const candidates: Array<[PaneDropZone, number]> = [
        ['left', horizontal],
        ['right', 1 - horizontal],
        ['up', vertical],
        ['down', 1 - vertical],
    ];
    const [zone, distance] = candidates.reduce((closest, candidate) =>
        candidate[1] < closest[1] ? candidate : closest,
    );
    return distance > EDGE_DROP_THRESHOLD ? 'center' : zone;
}
