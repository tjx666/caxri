import { PROJECT_PATH_DRAG_TYPE } from '../../lib/file-drag';

export type PaneDropZone = 'center' | 'down' | 'left' | 'right' | 'up';

/**
 * Placement payload shared by every pane tab. Editor path insertion carries a separate type so the drop target can
 * choose input without changing the common pane placement operations.
 */
export const PANE_TAB_DRAG_TYPE = 'application/x-caxri-pane-tab';

/**
 * Separate from Files drags so dragging an Editor cannot accidentally move its file in the explorer.
 */
export const EDITOR_PATH_DRAG_TYPE = 'application/x-caxri-editor-path';

/**
 * Editor paths paste into Terminal surfaces by default; Option opts back into pane placement.
 */
export function resolvePaneDropIntent(
    types: readonly string[],
    options: {
        altKey: boolean;
        isTerminal: boolean;
        acceptsFileDrop: boolean;
        hasFilePath: boolean;
    },
): 'paste' | 'place' | undefined {
    if (types.includes(PROJECT_PATH_DRAG_TYPE))
        return options.isTerminal && options.acceptsFileDrop ? 'paste' : undefined;
    if (options.isTerminal && types.includes(EDITOR_PATH_DRAG_TYPE) && !options.altKey)
        return options.acceptsFileDrop ? 'paste' : undefined;
    if (hasPaneTabDragType(types)) return 'place';
    return options.acceptsFileDrop && options.hasFilePath ? 'paste' : undefined;
}

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

/**
 * Geometry only, mirroring {@link resolvePaneDropZone}: given the left edges/widths of a pane bar's tabs (the dragged
 * tab itself already excluded) and the drop point's x, resolves which array index a reorder or cross-pane move-in drop
 * should insert at. `undefined` means "past every tab," i.e. append to the end.
 */
export function resolveTabDropIndex(
    tabRects: ReadonlyArray<{ left: number; width: number }>,
    clientX: number,
): number | undefined {
    const index = tabRects.findIndex((rect) => clientX < rect.left + rect.width / 2);
    return index === -1 ? undefined : index;
}
