import type { DragEvent } from 'react';

/** Custom MIME type carrying the dragged entry's absolute path between file-tree rows. */
export const FILE_TREE_DRAG_TYPE = 'application/x-caxri-file-path';

export function dragPath(event: DragEvent): string | undefined {
    return event.dataTransfer.getData(FILE_TREE_DRAG_TYPE) || undefined;
}

export function hasDraggedPath(event: DragEvent): boolean {
    return event.dataTransfer.types.includes(FILE_TREE_DRAG_TYPE);
}
