const MAX_LOCAL_BRANCHES = 1_000;

/**
 * Local branches, most recently committed first (GitLens-style recency). The earlier `--sort=refname` is the tiebreaker
 * — with multiple keys the last one is primary — and `%00` keeps the name/date split unambiguous because a branch name
 * cannot contain NUL.
 */
export async function listLocalBranches(
    git: (arguments_: string[]) => Promise<string>,
): Promise<Array<{ name: string; committedAt: number }>> {
    const output = await git([
        'for-each-ref',
        `--count=${MAX_LOCAL_BRANCHES}`,
        '--sort=refname',
        '--sort=-committerdate',
        '--format=%(refname:short)%00%(committerdate:unix)',
        'refs/heads',
    ]);
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [name, committedAt] = line.split('\0', 2);
            return { name, committedAt: Number(committedAt) * 1_000 };
        });
}
