/**
 * Extracts the host from a Git remote URL for the commit-avatar privacy gate. Handles every shape `git remote get-url`
 * actually prints: HTTPS/SSH URLs (`https://github.com/owner/repo.git`, `ssh://git@github.com/owner/repo.git`) and the
 * scp-like shorthand (`git@github.com:owner/repo.git`), which is not a URL and needs its own parse. Returns `null` for
 * an empty, missing, or unparseable remote so callers default to "unknown host" rather than guessing.
 */
export function parseGitRemoteHost(remoteUrl: string): string | null {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return null;
    if (!trimmed.includes('://')) {
        const scpLike = /^(?:[^@/]+@)?([^:/]+):/.exec(trimmed);
        if (scpLike) return scpLike[1].toLowerCase();
    }
    try {
        return new URL(trimmed).hostname.toLowerCase() || null;
    } catch {
        return null;
    }
}
