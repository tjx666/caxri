/**
 * Derives a machine-independent identity for a repository from its `origin` remote URL, so Desktop can show the same
 * repository checked out on several machines as one Project. `git@github.com:owner/repo.git`,
 * `ssh://git@github.com/owner/repo` and `https://token@github.com/Owner/Repo.git` all become `github.com/owner/repo`:
 * the scheme, user, credentials, port, `.git` suffix, and case are dropped, so the key never carries a secret and SSH
 * and HTTPS clones of one repository agree. Forks and mirrors keep different paths and never share a key.
 *
 * Returns `null` for a missing remote, a local-path or `file://` remote (two machines' paths say nothing about each
 * other), and anything unparseable, so callers never merge on a guess.
 */
export function deriveRepoKey(remoteUrl: string): string | null {
    const trimmed = remoteUrl.trim();
    if (!trimmed) return null;
    const parsed = trimmed.includes('://') ? parseUrlRemote(trimmed) : parseScpRemote(trimmed);
    if (!parsed) return null;
    const path = parsed.path
        .replaceAll(/\/+$/g, '')
        .replaceAll(/\.git$/gi, '')
        .replaceAll(/^\/+/g, '')
        .replaceAll(/\/{2,}/g, '/');
    if (!path || !parsed.host) return null;
    return `${parsed.host}/${path}`.toLowerCase();
}

function parseScpRemote(remote: string): { host: string; path: string } | null {
    const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(remote);
    if (!match) return null;
    return { host: match[1], path: match[2] };
}

function parseUrlRemote(remote: string): { host: string; path: string } | null {
    try {
        const url = new URL(remote);
        if (url.protocol === 'file:') return null;
        return { host: url.hostname, path: decodeURIComponent(url.pathname) };
    } catch {
        return null;
    }
}
