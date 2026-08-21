import type { DragEvent } from 'react';

/**
 * Custom MIME type carrying a Files entry's absolute path to internal Caxri drop targets.
 */
export const FILE_TREE_DRAG_TYPE = 'application/x-caxri-file-path';

export function dragPath(event: DragEvent): string | undefined {
    return event.dataTransfer.getData(FILE_TREE_DRAG_TYPE) || undefined;
}

export function hasDraggedPath(event: DragEvent): boolean {
    return event.dataTransfer.types.includes(FILE_TREE_DRAG_TYPE);
}

/**
 * Produces one POSIX-shell argument for Files-to-Terminal drops. Wrapping only paths with shell-significant characters
 * keeps ordinary paths readable while preventing spaces, quotes, and metacharacters from changing command structure.
 */
export function terminalInputPath(path: string): string {
    if (/^[\w@%+=:,./-]+$/.test(path)) return path;
    return `'${path.replaceAll("'", String.raw`'\''`)}'`;
}
