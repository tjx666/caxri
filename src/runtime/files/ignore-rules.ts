import { sep } from 'node:path';

/**
 * Directory names excluded from listings, watcher subscriptions, and polling signatures.
 *
 * VCS metadata (`.git`, `.hg`, `.svn`) and dependency/build output directories are large,
 * frequently-churning trees that add noise to the file tree, Git diffs, and watcher traffic
 * without adding value.
 */
const IGNORED_SEGMENTS = new Set([
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
]);

/**
 * File-name suffixes excluded from listings, watcher subscriptions, and polling signatures.
 *
 * `.db-wal` matches SQLite's write-ahead-log file. Caxri's own database runs in WAL mode (see
 * `db/connection.ts`), and a WAL file is rewritten on nearly every transaction; surfacing or
 * watching one would create constant listing/watcher churn for no benefit to the user.
 */
const IGNORED_SUFFIXES = ['.db-wal'];

/** True when a bare file or directory name should be excluded from a listing or signature scan. */
export function isIgnoredName(name: string): boolean {
    return IGNORED_SEGMENTS.has(name) || IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** True when any path segment matches an ignored directory name. */
export function isIgnoredPath(relativePath: string): boolean {
    return relativePath.split(sep).some((segment) => IGNORED_SEGMENTS.has(segment));
}

export const WATCHER_IGNORE_PATTERNS = [...IGNORED_SEGMENTS].flatMap((segment) => [
    `**/${segment}`,
    `**/${segment}/**`,
]);
