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

function stripTrailingSeparators(path: string): string {
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Rewrites an absolute path as the shortest form a shell running in `baseDirectory` resolves to the same entry. Paths
 * inside the base become relative (`src/index.ts`, `.` for the base itself); anything else stays absolute because a
 * `../`-chain is neither shorter nor clearer than the absolute path it replaces. A relative path that starts with `-`
 * is prefixed with `./` so the shell command does not parse it as an option.
 */
export function shellRelativePath(path: string, baseDirectory: string | undefined): string {
    if (!baseDirectory) return path;
    const base = stripTrailingSeparators(baseDirectory);
    const target = stripTrailingSeparators(path);
    if (target === base) return '.';
    const prefix = base.endsWith('/') ? base : `${base}/`;
    if (!target.startsWith(prefix)) return path;
    const relative = target.slice(prefix.length);
    return relative.startsWith('-') ? `./${relative}` : relative;
}

/**
 * Produces one POSIX-shell argument for Files-to-Terminal drops. The path is made relative to the Terminal's working
 * directory first, since the shorter spelling costs an Agent fewer tokens per reference and reads the way a person
 * would type it. Wrapping only paths with shell-significant characters keeps ordinary paths readable while preventing
 * spaces, quotes, and metacharacters from changing command structure.
 */
export function terminalInputPath(path: string, baseDirectory?: string): string {
    const input = shellRelativePath(path, baseDirectory);
    if (/^[\w@%+=:,./-]+$/.test(input)) return input;
    return `'${input.replaceAll("'", String.raw`'\''`)}'`;
}
