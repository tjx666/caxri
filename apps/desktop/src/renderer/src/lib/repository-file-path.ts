/* eslint-disable unicorn/name-replacements -- Repository is the domain term used by Git and Source Control. */

/**
 * Resolves a repository-relative file path to an absolute filesystem path without allowing the relative value to escape
 * the repository root. This is lexical validation only; the Server remains the authorization boundary.
 */
export function resolveRepositoryFilePath(
    repoRootPath: string | undefined,
    relativePath: string,
): string | undefined {
    if (!repoRootPath?.startsWith('/') || repoRootPath.includes('\0')) return;
    if (!relativePath || relativePath.includes('\0') || relativePath.startsWith('/')) return;
    if (relativePath.split('/').some((segment) => ['', '.', '..'].includes(segment))) return;
    const root = repoRootPath === '/' ? '/' : repoRootPath.replace(/\/+$/u, '');
    if (!root) return;
    return root === '/' ? `/${relativePath}` : `${root}/${relativePath}`;
}

/* eslint-enable unicorn/name-replacements */
