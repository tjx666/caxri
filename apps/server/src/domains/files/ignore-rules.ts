import { sep } from 'node:path';

/**
 * Directory names excluded from Project search and watcher traversal for bounded Server work.
 *
 * VCS metadata (`.git`, `.hg`, `.svn`) and dependency/build output directories are large, frequently-churning trees.
 * File-tree visibility is configured independently by `files.exclude`.
 */
export const PROJECT_TRAVERSAL_EXCLUDED_SEGMENTS = [
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    '.next',
    '.nuxt',
    '.turbo',
    '.cache',
    'coverage',
    'dist',
    'build',
    'out',
    'target',
] as const;
const TRAVERSAL_EXCLUDED_SEGMENTS = new Set<string>(PROJECT_TRAVERSAL_EXCLUDED_SEGMENTS);

/**
 * File-name suffixes excluded from Project search and polling signatures.
 *
 * `.db-wal` matches SQLite's write-ahead-log file. Caxri's own database runs in WAL mode (see `db/connection.ts`), and
 * a WAL file is rewritten on nearly every transaction; surfacing or watching one would create constant listing/watcher
 * churn for no benefit to the user.
 */
export const PROJECT_TRAVERSAL_EXCLUDED_SUFFIXES = ['.db-wal'] as const;

/**
 * True when bounded search or polling should skip a bare file or directory name.
 */
export function isTraversalExcludedName(name: string): boolean {
    return (
        TRAVERSAL_EXCLUDED_SEGMENTS.has(name) ||
        PROJECT_TRAVERSAL_EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))
    );
}

/**
 * True when bounded search or watching should skip any segment in a relative path.
 */
export function isTraversalExcludedPath(relativePath: string): boolean {
    return relativePath.split(sep).some((segment) => TRAVERSAL_EXCLUDED_SEGMENTS.has(segment));
}

export const WATCHER_EXCLUDE_PATTERNS = [...TRAVERSAL_EXCLUDED_SEGMENTS].flatMap((segment) => [
    `**/${segment}`,
    `**/${segment}/**`,
]);
