/** Matches one file or every descendant using Caxri's canonical absolute POSIX-style paths. */
export function pathIsAtOrBelow(path: string, parent: string): boolean {
    return path === parent || path.startsWith(`${parent}/`);
}

/** Replaces an exact path prefix while preserving any descendant suffix. */
export function remapPath(path: string, previousPath: string, nextPath: string): string {
    return pathIsAtOrBelow(path, previousPath)
        ? `${nextPath}${path.slice(previousPath.length)}`
        : path;
}

/** Returns a Project-relative POSIX path without letting Renderer state imply broader authority. */
export function projectRelativePath(path: string, projectRoot: string): string | undefined {
    if (path === projectRoot) return '.';
    return pathIsAtOrBelow(path, projectRoot) ? path.slice(projectRoot.length + 1) : undefined;
}
