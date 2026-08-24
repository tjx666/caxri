import type { GitDiffTab } from '@shared/git-diff';
import type { GitCommitDetails, GitFileStatus, GitPullRequestChanges } from '@shared/types';

import type { GitPanelMode } from './git-panel-state';
import { commitFilesToStatuses } from './git-tree';

export function gitRepoFilesForMode(
    mode: GitPanelMode,
    workingFiles: GitFileStatus[],
    latestCommit: GitCommitDetails | undefined,
    pullRequest: GitPullRequestChanges | null | undefined,
): GitFileStatus[] {
    if (mode === 'working') return workingFiles;
    if (mode === 'commit') return commitFilesToStatuses(latestCommit?.files ?? []);
    return pullRequest?.files ?? [];
}

export function gitRepoDisplayedCount(
    mode: GitPanelMode,
    changedFileCount: number,
    files: readonly GitFileStatus[],
): number {
    return mode === 'working' ? changedFileCount : files.length;
}

export function selectedGitRepoPath(
    mode: GitPanelMode,
    activeDiff: GitDiffTab | undefined,
    repoId: string,
    headSha: string | undefined,
): string | undefined {
    if (mode === 'commit')
        return activeDiff?.kind === 'commit-file' &&
            activeDiff.repositoryId === repoId &&
            activeDiff.sha === headSha
            ? activeDiff.path
            : undefined;
    return activeDiff?.kind === 'file' &&
        activeDiff.repositoryId === repoId &&
        activeDiff.source === mode
        ? activeDiff.path
        : undefined;
}

export function gitRepoEmptyMessage({
    headSha,
    latestCommit,
    latestCommitError,
    mode,
    pullRequest,
    pullRequestError,
}: {
    headSha: string | undefined;
    latestCommit: GitCommitDetails | undefined;
    latestCommitError: boolean;
    mode: GitPanelMode;
    pullRequest: GitPullRequestChanges | null | undefined;
    pullRequestError: boolean;
}): string {
    if (mode === 'working') return 'Working tree clean.';
    if (mode === 'commit') {
        if (!headSha) return 'No commits yet.';
        if (latestCommitError) return 'Unable to load the last commit.';
        return latestCommit === undefined
            ? 'Loading last commit…'
            : 'Last commit has no file changes.';
    }
    if (pullRequestError) return 'Unable to load pull request changes.';
    if (pullRequest === undefined) return 'Loading pull request changes…';
    return pullRequest === null
        ? 'No pull request for this branch.'
        : 'Pull request has no file changes.';
}
