import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { GitRepositorySummary as GitRepoSummary } from '@caxri/protocol';
import { CaxriError, isCaxriError } from '@caxri/protocol';

import { assertInsideRoot } from '../path-security';

/**
 * Resolves a Source Control history path filter to a repository-relative path, or `undefined` for the whole repository.
 * Symlinks and paths outside the repository are denied.
 */
export async function resolveHistoryPath(
    repo: GitRepoSummary,
    input?: string,
): Promise<string | undefined> {
    if (!input || input === '.') return undefined;
    const candidate = isAbsolute(input) ? input : resolve(repo.rootPath, input);
    try {
        const stats = await lstat(candidate);
        if (stats.isSymbolicLink())
            throw new CaxriError('PATH_DENIED', 'Git history path cannot be a symlink');
        const canonical = await realpath(candidate);
        const relativePath = relative(repo.rootPath, canonical);
        assertInsideRoot(relativePath, 'Git history path is outside the selected repository');
        return relativePath || undefined;
    } catch (error) {
        // The Renderer debounces the history path filter, so partial or nonexistent input is
        // expected while the user types; surface it as NOT_FOUND rather than a generic INTERNAL
        // failure that renders as an alarming "Unable to load commits" error.
        if (isCaxriError(error)) throw error;
        if (
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        )
            throw new CaxriError('NOT_FOUND', 'Git history path does not exist in the repository');
        throw error;
    }
}
