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
