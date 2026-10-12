import { isPathAtOrBelow } from '@caxri/protocol';

/**
 * Replaces an exact path prefix while preserving any descendant suffix.
 */
export function remapPath(path: string, previousPath: string, nextPath: string): string {
    if (!isPathAtOrBelow(path, previousPath)) return path;
    if (path === previousPath) return nextPath;
    const suffix = previousPath === '/' ? path.slice(1) : path.slice(previousPath.length + 1);
    return nextPath === '/' ? `/${suffix}` : `${nextPath}/${suffix}`;
}

/**
 * Returns the directory whose listing directly owns an absolute path.
 */
export function parentDirectoryPath(path: string): string {
    const separator = path.lastIndexOf('/');
    if (separator === -1) return '';
    return separator === 0 ? '/' : path.slice(0, separator);
}
