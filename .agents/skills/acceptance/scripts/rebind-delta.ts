import { execFileAsync } from '@caxri/system';

import { PROJECT_ROOT } from './report-paths';

/**
 * `<rev>^{commit}` in git's own syntax, kept out of a template literal so it is not read as an interpolation.
 */
const COMMIT_PEEL = '^{commit}';

async function resolveCommit(revision: string, gitRoot: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['rev-parse', '--verify', '--quiet', revision + COMMIT_PEEL, '--'],
            { cwd: gitRoot },
        );
        const resolved = stdout.trim();
        if (!/^[0-9a-f]{40}$/.test(resolved)) throw new Error('unexpected rev-parse output');
        return resolved;
    } catch (error: unknown) {
        throw new Error(`Cannot resolve ${revision} to a commit in this repository`, {
            cause: error,
        });
    }
}

/**
 * Lists what two heads actually differ in, so a rebind is judged by the delta rather than by the caller's description
 * of it. Both revisions must resolve to a commit in this repository; anything else fails closed.
 */
export async function changedPathsBetween(
    fromCommit: string,
    commit: string,
    gitRoot: string = PROJECT_ROOT,
): Promise<string[]> {
    /**
     * Both revisions are resolved to a full object id first, so a value that begins with `-` reaches `git diff` as a
     * hash rather than as an option. Without this, `--output=<file>..<sha>` exits 0 with empty stdout, and an empty
     * delta is exactly what the rebind gate reads as "safe".
     */
    const from = await resolveCommit(fromCommit, gitRoot);
    const to = await resolveCommit(commit, gitRoot);
    let stdout: string;
    try {
        /**
         * `--no-renames` is load-bearing, not tidiness: with rename detection on, moving a product file into `.agents/`
         * reports only the destination path, and the gate would accept a head that deleted product source.
         */
        ({ stdout } = await execFileAsync(
            'git',
            ['diff', '--name-only', '-z', '--no-renames', `${from}..${to}`, '--'],
            { cwd: gitRoot },
        ));
    } catch (error: unknown) {
        throw new Error(`Cannot compare ${from}..${to} to check the rebind delta`, {
            cause: error,
        });
    }
    return stdout.split('\0').filter(Boolean);
}
