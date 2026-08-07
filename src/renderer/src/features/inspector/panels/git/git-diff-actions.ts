import {
    gitChangesDiffTabPath,
    gitFileDiffTabPath,
    gitPullRequestChangesDiffTabPath,
    gitPullRequestFileDiffTabPath,
} from '@shared/git-diff';

import { openEditorTab } from '../../../editor/document-actions';

export function openGitFileDiff(repositoryId: string, path: string): void {
    openEditorTab(gitFileDiffTabPath(repositoryId, path));
}

export function openGitChangesDiff(repositoryId: string, repositoryName: string): void {
    openEditorTab(gitChangesDiffTabPath(repositoryId, repositoryName));
}

export function openPullRequestFileDiff(repositoryId: string, path: string): void {
    openEditorTab(gitPullRequestFileDiffTabPath(repositoryId, path));
}

export function openPullRequestChangesDiff(repositoryId: string, repositoryName: string): void {
    openEditorTab(gitPullRequestChangesDiffTabPath(repositoryId, repositoryName));
}
