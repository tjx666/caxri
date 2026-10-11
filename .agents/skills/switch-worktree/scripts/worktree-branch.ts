import { CommandError, runCapture } from './process';

async function didGitSucceed(root: string, arguments_: string[]): Promise<boolean> {
    try {
        await runCapture('git', arguments_, root);
        return true;
    } catch {
        return false;
    }
}

export async function hasBranch(root: string, branch: string): Promise<boolean> {
    return didGitSucceed(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
}

/**
 * `create` resumes a branch that already exists instead of starting a new one, so an explicit `--base` would otherwise
 * be ignored silently: a reused branch name once checked out a months-old merged branch in the pre-monorepo layout and
 * ran an install against it. Refuse when the existing branch does not already contain the requested base.
 */
export async function assertBranchContainsBase(
    root: string,
    branch: string,
    base: string | undefined,
): Promise<void> {
    if (!base) return;
    if (!(await didGitSucceed(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])))
        return;
    if (await didGitSucceed(root, ['merge-base', '--is-ancestor', base, `refs/heads/${branch}`]))
        return;
    throw new CommandError(
        `Branch ${branch} already exists and does not contain ${base}, so --base would be ignored. ` +
            `Choose a new branch name, or run \`switch ${branch}\` to resume the existing branch.`,
        2,
    );
}
