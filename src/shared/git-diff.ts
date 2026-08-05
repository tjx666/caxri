export type GitDiffTab =
    | { kind: 'file'; path: string; repositoryId: string }
    | { kind: 'changes'; repositoryId: string; repositoryName: string };

const GIT_DIFF_TAB_PREFIX = 'caxri-git-diff://';

export function gitFileDiffTabPath(repositoryId: string, path: string): string {
    return `${GIT_DIFF_TAB_PREFIX}file/${encodeURIComponent(repositoryId)}/${encodeURIComponent(path)}`;
}

export function gitChangesDiffTabPath(repositoryId: string, repositoryName: string): string {
    return `${GIT_DIFF_TAB_PREFIX}changes/${encodeURIComponent(repositoryId)}/${encodeURIComponent(repositoryName)}`;
}

export function parseGitDiffTab(path: string): GitDiffTab | undefined {
    if (!path.startsWith(GIT_DIFF_TAB_PREFIX)) return undefined;
    const match = /^(file|changes)\/([^/]+)\/(.+)$/.exec(path.slice(GIT_DIFF_TAB_PREFIX.length));
    if (!match) return undefined;
    try {
        const repositoryId = decodeURIComponent(match[2]);
        const value = decodeURIComponent(match[3]);
        return match[1] === 'file'
            ? { kind: 'file', path: value, repositoryId }
            : { kind: 'changes', repositoryId, repositoryName: value };
    } catch {
        return undefined;
    }
}

export function isGitDiffTabPath(path: string): boolean {
    return Boolean(parseGitDiffTab(path));
}

export function gitDiffTabLabel(tab: GitDiffTab): string {
    return tab.kind === 'changes'
        ? `Changes: ${tab.repositoryName}`
        : (tab.path.split('/').filter(Boolean).at(-1) ?? tab.path);
}

/** Gives both Monaco sides unique Session-scoped URIs while preserving file extensions. */
export function gitDiffModelPath(
    sessionId: string,
    repositoryId: string,
    path: string,
    side: 'original' | 'modified',
): string {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `caxri://git-diff/${encodeURIComponent(sessionId)}/${encodeURIComponent(repositoryId)}/${side}/${encodedPath}`;
}
