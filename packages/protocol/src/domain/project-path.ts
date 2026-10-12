/**
 * Project-relative path helpers for Caxri's canonical absolute POSIX-style paths. They live in the protocol package so
 * Desktop and the Server's mobile projection name a Project file the same way; implemented without `node:path` because
 * the sandboxed Renderer shares them.
 */

/**
 * Matches one file or every descendant.
 */
export function isPathAtOrBelow(path: string, parent: string): boolean {
    return (
        path === parent || (parent === '/' ? path.startsWith('/') : path.startsWith(`${parent}/`))
    );
}

/**
 * Returns a Project-relative POSIX path, or `undefined` for a path outside the Project, without letting the caller's
 * state imply broader authority.
 */
export function projectRelativePath(path: string, projectRoot: string): string | undefined {
    if (path === projectRoot) return '.';
    if (!isPathAtOrBelow(path, projectRoot)) return undefined;
    return projectRoot === '/' ? path.slice(1) : path.slice(projectRoot.length + 1);
}

/**
 * How a file the Agent touched is named to the user: Project-relative inside the Project (`src/app.ts`), and absolute
 * when it lies outside or the root is unknown, so the name never hides that the Agent left the Project.
 */
export function projectDisplayPath(path: string, projectRoot: string | undefined): string {
    return (projectRoot === undefined ? undefined : projectRelativePath(path, projectRoot)) ?? path;
}
