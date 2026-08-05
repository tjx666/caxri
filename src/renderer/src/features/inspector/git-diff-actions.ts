import { gitChangesDiffTabPath, gitFileDiffTabPath } from '@shared/git-diff';

import { openEditorTab } from '../editor/document-actions';

export function openGitFileDiff(repositoryId: string, path: string): void {
    openEditorTab(gitFileDiffTabPath(repositoryId, path));
}

export function openGitChangesDiff(repositoryId: string, repositoryName: string): void {
    openEditorTab(gitChangesDiffTabPath(repositoryId, repositoryName));
}
