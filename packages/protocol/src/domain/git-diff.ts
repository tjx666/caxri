import { pathBasename } from '@caxri/utils';

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
          showExcluded?: true;
          source: 'pull-request' | 'working';
      }
    | {
          kind: 'commit-file';
          path: string;
          repositoryId: string;
          sha: string;
          source: 'commit';
      };

/**
 * Whether the tab's modified side is the file the checkout holds right now.
 *
 * Only an uncommitted working-tree comparison qualifies. A commit or pull-request comparison renders a snapshot read
 * with `git show <sha>:<path>`, so its line numbers address a past revision and the path may not exist on disk at all.
 * Anything that carries a caret into the real file, or types a `@path#Lnn` reference with no Server round-trip to
 * confirm the file, must gate on this rather than on `kind` alone.
 */
export function isWorkingFileDiffTab(
    tab: GitDiffTab,
): tab is Extract<GitDiffTab, { kind: 'file' }> {
    return tab.kind === 'file' && tab.source === 'working';
}

const GIT_DIFF_TAB_PREFIX = 'caxri-git-diff://';

export function gitFileDiffTabPath(repoId: string, path: string): string {
    return `${GIT_DIFF_TAB_PREFIX}file/${encodeURIComponent(repoId)}/${encodeURIComponent(path)}`;
}

export function gitChangesDiffTabPath(
    repoId: string,
    repoName: string,
    isShowingExcluded = false,
): string {
    const path = `${GIT_DIFF_TAB_PREFIX}changes/${encodeURIComponent(repoId)}/${encodeURIComponent(repoName)}`;
    return isShowingExcluded ? `${path}?showExcluded=true` : path;
}

export function gitPullRequestFileDiffTabPath(repoId: string, path: string): string {
    return `${GIT_DIFF_TAB_PREFIX}pr-file/${encodeURIComponent(repoId)}/${encodeURIComponent(path)}`;
}

export function gitPullRequestChangesDiffTabPath(
    repoId: string,
    repoName: string,
    isShowingExcluded = false,
): string {
    const path = `${GIT_DIFF_TAB_PREFIX}pr-changes/${encodeURIComponent(repoId)}/${encodeURIComponent(repoName)}`;
    return isShowingExcluded ? `${path}?showExcluded=true` : path;
}

export function gitCommitFileDiffTabPath(repoId: string, sha: string, path: string): string {
    return `${GIT_DIFF_TAB_PREFIX}commit-file/${encodeURIComponent(repoId)}/${sha}/${encodeURIComponent(path)}`;
}

export function parseGitDiffTab(path: string): GitDiffTab | undefined {
    if (!path.startsWith(GIT_DIFF_TAB_PREFIX)) return undefined;
    const rest = path.slice(GIT_DIFF_TAB_PREFIX.length);
    try {
        const commitMatch = /^commit-file\/([^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(rest);
        if (commitMatch)
            return {
                kind: 'commit-file',
                path: decodeURIComponent(commitMatch[3]),
                repositoryId: decodeURIComponent(commitMatch[1]),
                sha: commitMatch[2],
                source: 'commit',
            };
        const fileMatch = /^(file|pr-file)\/([^/]+)\/([^?]+)$/.exec(rest);
        if (fileMatch) {
            const source = fileMatch[1].startsWith('pr-') ? 'pull-request' : 'working';
            return {
                kind: 'file',
                path: decodeURIComponent(fileMatch[3]),
                repositoryId: decodeURIComponent(fileMatch[2]),
                source,
            };
        }
        const changesMatch = /^(changes|pr-changes)\/([^/]+)\/([^?]+)(\?showExcluded=true)?$/.exec(
            rest,
        );
        if (!changesMatch) return undefined;
        const source = changesMatch[1].startsWith('pr-') ? 'pull-request' : 'working';
        return {
            kind: 'changes',
            repositoryId: decodeURIComponent(changesMatch[2]),
            repositoryName: decodeURIComponent(changesMatch[3]),
            ...(changesMatch[4] && { showExcluded: true as const }),
            source,
        };
    } catch {
        return undefined;
    }
}

export function isGitDiffTabPath(path: string): boolean {
    return Boolean(parseGitDiffTab(path));
}

export function gitDiffTabLabel(tab: GitDiffTab): string {
    if (tab.kind === 'changes')
        return `${tab.source === 'pull-request' ? 'PR Changes' : 'Changes'}: ${tab.repositoryName}`;
    if (tab.kind === 'commit-file') return `${pathBasename(tab.path)} (${tab.sha.slice(0, 7)})`;
    return pathBasename(tab.path);
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
