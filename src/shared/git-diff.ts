export type GitDiffTab =
    | {
          kind: 'file';
          path: string;
          repositoryId: string;
          source: 'pull-request' | 'working';
      }
    | {
          kind: 'changes';
          repositoryId: string;
          repositoryName: string;
          source: 'pull-request' | 'working';
      };

const GIT_DIFF_TAB_PREFIX = 'caxri-git-diff://';

export function gitFileDiffTabPath(repoId: string, path: string): string {
    return `${GIT_DIFF_TAB_PREFIX}file/${encodeURIComponent(repoId)}/${encodeURIComponent(path)}`;
}

export function gitChangesDiffTabPath(repoId: string, repoName: string): string {
    return `${GIT_DIFF_TAB_PREFIX}changes/${encodeURIComponent(repoId)}/${encodeURIComponent(repoName)}`;
}

export function gitPullRequestFileDiffTabPath(repoId: string, path: string): string {
    return `${GIT_DIFF_TAB_PREFIX}pr-file/${encodeURIComponent(repoId)}/${encodeURIComponent(path)}`;
}

export function gitPullRequestChangesDiffTabPath(repoId: string, repoName: string): string {
    return `${GIT_DIFF_TAB_PREFIX}pr-changes/${encodeURIComponent(repoId)}/${encodeURIComponent(repoName)}`;
}

export function parseGitDiffTab(path: string): GitDiffTab | undefined {
    if (!path.startsWith(GIT_DIFF_TAB_PREFIX)) return undefined;
    const match = /^(file|changes|pr-file|pr-changes)\/([^/]+)\/(.+)$/.exec(
        path.slice(GIT_DIFF_TAB_PREFIX.length),
    );
    if (!match) return undefined;
    try {
        const repoId = decodeURIComponent(match[2]);
        const value = decodeURIComponent(match[3]);
        const source = match[1].startsWith('pr-') ? 'pull-request' : 'working';
        return match[1].endsWith('file')
            ? { kind: 'file', path: value, repositoryId: repoId, source }
            : { kind: 'changes', repositoryId: repoId, repositoryName: value, source };
    } catch {
        return undefined;
    }
}

export function isGitDiffTabPath(path: string): boolean {
    return Boolean(parseGitDiffTab(path));
}

export function gitDiffTabLabel(tab: GitDiffTab): string {
    return tab.kind === 'changes'
        ? `${tab.source === 'pull-request' ? 'PR Changes' : 'Changes'}: ${tab.repositoryName}`
        : (tab.path.split('/').findLast(Boolean) ?? tab.path);
}

/**
 * Gives both Monaco sides unique Session-scoped URIs while preserving file extensions.
 */
export function gitDiffModelPath(
    sessionId: string,
    repoId: string,
    path: string,
    side: 'original' | 'modified',
): string {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `caxri://git-diff/${encodeURIComponent(sessionId)}/${encodeURIComponent(repoId)}/${side}/${encodedPath}`;
}
