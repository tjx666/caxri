/**
 * Extracts the last non-empty `/` or `\` separated segment of `path` for display purposes, e.g. showing a file name in
 * a UI label. This is cross-platform and string-only: it does not consult the filesystem and is not a substitute for
 * Node's `path.basename` when platform-accurate parsing (drive letters, `.` / `..` semantics) matters.
 */
export function pathBasename(path: string): string {
    return path.split(/[\\/]/).findLast(Boolean) ?? path;
}
