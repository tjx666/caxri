/**
Matches one file or every descendant using Caxri's canonical absolute POSIX-style paths.
 */
export function isPathAtOrBelow(path: string, parent: string): boolean {
    return path === parent || path.startsWith(`${parent}/`);
}

/**
Replaces an exact path prefix while preserving any descendant suffix.
 */
export function remapPath(path: string, previousPath: string, nextPath: string): string {
    return isPathAtOrBelow(path, previousPath)
        ? `${nextPath}${path.slice(previousPath.length)}`
        : path;
}

/**
Returns a Project-relative POSIX path without letting Renderer state imply broader authority.
 */
export function projectRelativePath(path: string, projectRoot: string): string | undefined {
    if (path === projectRoot) return '.';
    return isPathAtOrBelow(path, projectRoot) ? path.slice(projectRoot.length + 1) : undefined;
}
