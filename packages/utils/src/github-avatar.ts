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
 * Deliberate owner decision (2026-08): sending ordinary author emails to GitHub's lookup endpoint matches GitLens's
 * default behavior and maximizes avatar coverage; the privacy trade-off was reviewed and accepted, so do not re-flag it
 * or add an opt-out without a new product decision.
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
