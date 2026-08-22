import {
    gitChangesDiffTabPath,
    gitCommitFileDiffTabPath,
    gitFileDiffTabPath,
    gitPullRequestChangesDiffTabPath,
    gitPullRequestFileDiffTabPath,
} from '@shared/git-diff';

import { openEditorTab } from '../../../editor/document-actions';

export function openGitFileDiff(repoId: string, path: string): void {
    openEditorTab(gitFileDiffTabPath(repoId, path));
}

export function openGitChangesDiff(repoId: string, repoName: string): void {
    openEditorTab(gitChangesDiffTabPath(repoId, repoName));
}

export function openPullRequestFileDiff(repoId: string, path: string): void {
    openEditorTab(gitPullRequestFileDiffTabPath(repoId, path));
}

export function openPullRequestChangesDiff(repoId: string, repoName: string): void {
    openEditorTab(gitPullRequestChangesDiffTabPath(repoId, repoName));
}

export function openGitCommitFileDiff(repoId: string, sha: string, path: string): void {
    openEditorTab(gitCommitFileDiffTabPath(repoId, sha, path));
}
