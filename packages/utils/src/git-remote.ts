export interface GitHubRepoSlug {
    owner: string;
    repo: string;
}

/**
 * Parses GitHub HTTPS, SSH URL, and scp-like remote forms without performing network access.
 */
export function parseGitHubRemote(value: string): GitHubRepoSlug | undefined {
    const normalized = value
        .trim()
        .replace(/\/$/, '')
        .replace(/\.git$/, '');
    const scpLike = normalized.match(/^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+)$/i);
    if (scpLike) return { owner: scpLike[1], repo: scpLike[2] };
    try {
        const url = new URL(normalized.includes('://') ? normalized : `https://${normalized}`);
        if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) return;
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments.length !== 2) return;
        return { owner: segments[0], repo: segments[1] };
    } catch {
        return;
    }
}
