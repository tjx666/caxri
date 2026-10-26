/**
 * GitHub-hosted noreply address: `12345+login@users.noreply.github.com` (current) or the legacy
 * `login@users.noreply.github.com` without the numeric account id.
 */
const GITHUB_NOREPLY_PATTERN = /^(?:(\d+)\+)?([\w-]+(?:\[bot\])?)@users\.noreply\.github\.com$/i;

/**
 * Resolves a commit author email to a GitHub avatar URL, GitLens-style. Noreply addresses map straight to the account's
 * avatar; any other email goes through GitHub's email lookup endpoint, which serves the linked account's avatar or a
 * generated identicon fallback. Returns `undefined` for an empty email so callers render their own placeholder.
 *
 * Revised owner decision (2026-10): sending ordinary author emails to GitHub's lookup endpoint is a real network
 * disclosure of the author's email, so `git.fetchGitHubAvatars` is off by default and the lookup happens only after the
 * user opts in (GitLens defaults it on; Caxri does not). Callers must gate this behind {@link shouldFetchGitHubAvatar}
 * (the `git.fetchGitHubAvatars` setting and a confirmed `github.com` remote) instead of calling it unconditionally.
 */
export function gitHubAvatarUrl(email: string, size: number): string | undefined {
    const trimmed = email.trim();
    if (!trimmed) return undefined;
    const noreply = GITHUB_NOREPLY_PATTERN.exec(trimmed);
    if (noreply) {
        return noreply[1]
            ? `https://avatars.githubusercontent.com/u/${noreply[1]}?s=${size}&v=4`
            : `https://avatars.githubusercontent.com/${noreply[2]}?s=${size}&v=4`;
    }
    return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(trimmed)}&s=${size}`;
}

/**
 * Gate for {@link gitHubAvatarUrl}: an author email only ever reaches github.com when the user opted in via
 * `git.fetchGitHubAvatars` AND the repository's remote host is exactly `github.com`. Unknown hosts, missing remotes,
 * and GitHub Enterprise custom domains are conservatively treated as "do not fetch": this function never assumes an
 * unfamiliar host behaves like github.com's public avatar/email-lookup endpoints.
 */
export function shouldFetchGitHubAvatar(
    remoteHost: string | null | undefined,
    isSettingEnabled: boolean,
): boolean {
    return isSettingEnabled && remoteHost === 'github.com';
}
