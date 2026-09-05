import { relative, sep } from 'node:path';

/**
 * Picks the shallowest match (ties broken by path order) so the breadcrumb stays predictable across keystrokes.
 */
export function shallowestProjectPath(root: string, paths: readonly string[]): string | undefined {
    return paths
        .map((path) => ({ path, depth: relative(root, path).split(sep).length }))
        .toSorted((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
        .at(0)?.path;
}
