export type EditorDropZone = 'center' | 'down' | 'left' | 'right' | 'up';

/**
 * Custom MIME type for Editor tab drags. Mirrored here (rather than imported from `editor-layout-actions`) so the
 * drag-type probe used during `dragover` stays free of the action module's store imports.
 */
export const EDITOR_DRAG_TYPE = 'application/x-caxri-editor';

/**
 * `DataTransfer.getData` is empty during `dragenter`/`dragover` in Chromium's protected drag store; only `types` is
 * reliable before `drop`. Preview/accept the drag from the custom type, never from `text/plain` (that would treat
 * selected text as an Editor tab).
 */
export function hasEditorDragType(types: readonly string[]): boolean {
    return types.includes(EDITOR_DRAG_TYPE);
}

/**
 * The same path may be open in several groups at once, so a center drop must know which occurrence the drag started
 * from — the drag source encodes it, because the drop target can only guess (`findPathGroupId` returns the first
 * match). `sourceGroupId` stays optional: a drag can start from surfaces that track no group (and older payloads were a
 * bare path string, which `decodeEditorDragPayload` still accepts).
 */
export interface EditorDragPayload {
    path: string;
    sourceGroupId?: string;
}

export function encodeEditorDragPayload(payload: EditorDragPayload): string {
    return JSON.stringify(payload);
}

export function decodeEditorDragPayload(raw: string): EditorDragPayload | undefined {
    if (!raw) return undefined;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && 'path' in parsed) {
            const { path, sourceGroupId } = parsed as { path?: unknown; sourceGroupId?: unknown };
            if (typeof path === 'string' && path) {
                return {
                    path,
                    ...(typeof sourceGroupId === 'string' && sourceGroupId && { sourceGroupId }),
                };
            }
        }
        return undefined;
    } catch {
        // Not JSON: treat the raw data as a bare path (`text/plain` fallback).
        return { path: raw };
    }
}

/**
 * Fraction of a group's width/height, measured from the nearest edge, that counts as an edge drop rather than a center
 * "move into this group" drop. Kept inside the documented 20%-25% band from the Phase 4 spec.
 */
const EDGE_DROP_THRESHOLD = 0.25;

/**
 * Geometry only: given a group's bounding box and a point within it, resolves which of the four edge zones (each
 * `EDGE_DROP_THRESHOLD` of the nearest dimension, measured from that edge) or the remaining center zone the point falls
 * in. Lives outside `editor-layout-view.tsx` so the component file only exports components (react-refresh) and the
 * four-edge drop math stays unit-testable without a DOM.
 */
export function resolveEditorDropZone(
    bounds: { height: number; width: number },
    point: { x: number; y: number },
): EditorDropZone {
    if (bounds.width <= 0 || bounds.height <= 0) return 'center';
    const horizontal = point.x / bounds.width;
    const vertical = point.y / bounds.height;
    const candidates: Array<[EditorDropZone, number]> = [
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
