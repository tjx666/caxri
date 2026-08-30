/**
 * Matches one file or every descendant using Caxri's canonical absolute POSIX-style paths.
 */
export function isPathAtOrBelow(path: string, parent: string): boolean {
    return (
        path === parent || (parent === '/' ? path.startsWith('/') : path.startsWith(`${parent}/`))
    );
}

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
 * Returns a Project-relative POSIX path without letting Renderer state imply broader authority.
 */
export function projectRelativePath(path: string, projectRoot: string): string | undefined {
    if (path === projectRoot) return '.';
    if (!isPathAtOrBelow(path, projectRoot)) return undefined;
    return projectRoot === '/' ? path.slice(1) : path.slice(projectRoot.length + 1);
}

/**
 * Returns the directory whose listing directly owns an absolute path.
 */
export function parentDirectoryPath(path: string): string {
    const separator = path.lastIndexOf('/');
    if (separator === -1) return '';
    return separator === 0 ? '/' : path.slice(0, separator);
}
