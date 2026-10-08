import type { GitCommitDetails, GitCommitFile } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { COMMIT_FORMAT, parseCommitLog } from './commit-log';
import { parseGitNumstat, sumGitLineStats, withGitLineStat } from './numstat';

const MAX_COMMIT_FILES = 500;

function commitFileStatus(code: string): GitCommitFile['status'] {
    if (code.startsWith('A')) return 'added';
    if (code.startsWith('D')) return 'deleted';
    if (code.startsWith('R')) return 'renamed';
    if (code.startsWith('C')) return 'copied';
    if (code.startsWith('T')) return 'type-changed';
    if (code.startsWith('M')) return 'modified';
    return 'unknown';
}

export function parseCommitFiles(output: string): GitCommitFile[] {
    const fields = output.split('\0').filter(Boolean);
    const files: GitCommitFile[] = [];
    for (let index = 0; index < fields.length;) {
        const code = fields[index++];
        if (!code) break;
        if (code.startsWith('R') || code.startsWith('C')) {
            const previousPath = fields[index++];
            const path = fields[index++];
            if (!path || !previousPath)
                throw new CaxriError('GIT', 'Git returned malformed commit files');
            files.push({ path, previousPath, status: commitFileStatus(code) });
            continue;
        }
        const path = fields[index++];
        if (!path) throw new CaxriError('GIT', 'Git returned malformed commit files');
        files.push({ path, status: commitFileStatus(code) });
    }
    return files;
}

/**
 * A commit's message, its changed files, and its line totals, read together.
 *
 * Owned here rather than on the Git domain because it is three `git` invocations and two parsers that only ever run as
 * one unit, including for the Terminal reference hover card, which needs exactly this projection and nothing the
 * domain's Session plumbing adds.
 */
export async function readCommitDetails(
    sha: string,
    options: {
        git: (arguments_: string[]) => Promise<string>;
        /**
         * Restricts the file list to one repository-relative path, as the history view does when following a file.
         */
        path: () => Promise<string | undefined>;
    },
): Promise<GitCommitDetails> {
    const [path, commitOutput] = await Promise.all([
        options.path(),
        options.git(['show', '-s', '-z', '--decorate=short', `--format=${COMMIT_FORMAT}`, sha]),
    ]);
    // `.at(0)` (not `[0]`) keeps the result typed as possibly missing: `git show` can return no
    // parseable commit line for a stale or unknown sha.
    const commit = parseCommitLog(commitOutput).at(0);
    if (!commit) throw new CaxriError('NOT_FOUND', 'Git commit no longer exists');
    const fileArguments = [
        'diff-tree',
        '--root',
        '--first-parent',
        '-m',
        '--no-commit-id',
        '--name-status',
        '-r',
        '-z',
        '-M',
        sha,
    ];
    if (path) fileArguments.push('--', path);
    const numstatArguments = fileArguments.map((argument) =>
        argument === '--name-status' ? '--numstat' : argument,
    );
    const [filesOutput, numstatOutput] = await Promise.all([
        options.git(fileArguments),
        options.git(numstatArguments),
    ]);
    const files = parseCommitFiles(filesOutput);
    const lineStats = parseGitNumstat(numstatOutput);
    return {
        commit,
        files: files.slice(0, MAX_COMMIT_FILES).map((file) => withGitLineStat(file, lineStats)),
        filesTruncated: files.length > MAX_COMMIT_FILES,
        ...sumGitLineStats(lineStats.values()),
    };
}
