import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { CheckError } from './check-arguments';

/**
 * One file argument as typed, beside its repository-relative path.
 */
export interface ExplicitFile {
    argument: string;
    path: string;
}

/**
 * Runs `git` with these arguments in the repository and resolves to its stdout.
 */
type GitCapture = (arguments_: string[]) => Promise<string>;

/**
 * Paths Git records as deleted: on the branch since the `origin/main` merge base, or not yet committed (staged or not),
 * which also covers a file the branch added and then removed. A rename counts as its deleted source, as it does in
 * changed-file discovery.
 */
async function deletedPaths(git: GitCapture): Promise<Set<string>> {
    const deletedSince = async (revision: string): Promise<string[]> =>
        (
            await git([
                'diff',
                revision,
                '--no-renames',
                '--name-only',
                '-z',
                '--diff-filter=D',
                '--',
            ])
        )
            .split('\0')
            .filter(Boolean);
    const mergeBase = (await git(['merge-base', 'origin/main', 'HEAD'])).trim();
    const lists = await Promise.all([deletedSince(mergeBase), deletedSince('HEAD')]);
    return new Set(lists.flat());
}

async function fileKind(
    root: string,
    path: string,
): Promise<'directory' | 'file' | 'missing' | 'other'> {
    try {
        const stats = await lstat(join(root, path));
        if (stats.isFile()) return 'file';
        return stats.isDirectory() ? 'directory' : 'other';
    } catch {
        return 'missing';
    }
}

/**
 * Rejects, before any gate runs, an explicit argument that names no file to check. A mistyped path, a directory, or
 * several paths joined into one argument (an unsplit shell variable) used to match nothing, and the check then reported
 * a green "0 changed" without checking a file. A missing path still passes when Git records it as deleted, because a
 * removed path selects the tests that still reference it.
 */
export async function assertExplicitFiles(
    root: string,
    files: ExplicitFile[],
    git: GitCapture,
): Promise<void> {
    const kinds = await Promise.all(files.map(({ path }) => fileKind(root, path)));
    const deleted = kinds.includes('missing') ? await deletedPaths(git) : new Set<string>();
    const rejected = files.flatMap(({ argument, path }, index) => {
        const kind = kinds[index];
        if (kind === 'file' || (kind === 'missing' && deleted.has(path))) return [];
        return [{ argument, kind }];
    });
    if (rejected.length === 0) return;

    const hasJoinedPaths = rejected.some(
        ({ argument, kind }) => kind === 'missing' && /\s/u.test(argument),
    );
    throw new CheckError(
        [
            'These file arguments name nothing to check:',
            ...rejected.map(({ argument, kind }) => {
                const reason =
                    kind === 'directory'
                        ? 'a directory; pass the files inside it, e.g. from `rg --files <directory>`'
                        : kind === 'other'
                          ? 'not a regular file'
                          : 'no such file, and Git records no deletion at this path';
                return `  ${JSON.stringify(argument)}: ${reason}`;
            }),
            ...(hasJoinedPaths
                ? [
                      'Pass one path per argument, e.g. `git diff --name-only | xargs bun run --silent check --lint`.',
                  ]
                : []),
        ].join('\n'),
        2,
    );
}
