import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    openEditorTab: vi.fn(),
}));

vi.mock('../../../editor/document-actions', () => ({ openEditorTab: mocks.openEditorTab }));

// Real (unmocked) tab-path builders so each assertion below fails if an action ever wires the
// wrong builder to the wrong tab-path prefix (`file` vs `changes` vs `pr-file` vs `pr-changes`),
// which is exactly the copy-paste cross-wiring bug this suite guards against.
import {
    gitChangesDiffTabPath,
    gitFileDiffTabPath,
    gitPullRequestChangesDiffTabPath,
    gitPullRequestFileDiffTabPath,
} from '@shared/git-diff';

import {
    openGitChangesDiff,
    openGitFileDiff,
    openPullRequestChangesDiff,
    openPullRequestFileDiff,
} from './git-diff-actions';

describe('git-diff-actions', () => {
    it('opens the working-tree file diff tab', () => {
        openGitFileDiff('repo-1', 'src/index.ts');

        expect(mocks.openEditorTab).toHaveBeenCalledWith(
            gitFileDiffTabPath('repo-1', 'src/index.ts'),
        );
    });

    it('opens the working-tree changes diff tab', () => {
        openGitChangesDiff('repo-1', 'caxri');

        expect(mocks.openEditorTab).toHaveBeenCalledWith(gitChangesDiffTabPath('repo-1', 'caxri'));
    });

    it('opens the pull-request file diff tab', () => {
        openPullRequestFileDiff('repo-1', 'src/index.ts');

        expect(mocks.openEditorTab).toHaveBeenCalledWith(
            gitPullRequestFileDiffTabPath('repo-1', 'src/index.ts'),
        );
    });

    it('opens the pull-request changes diff tab', () => {
        openPullRequestChangesDiff('repo-1', 'caxri');

        expect(mocks.openEditorTab).toHaveBeenCalledWith(
            gitPullRequestChangesDiffTabPath('repo-1', 'caxri'),
        );
    });

    it('keeps each action distinct from the other three tab-path builders', () => {
        openGitFileDiff('repo-1', 'src/index.ts');
        const [callArgument] = mocks.openEditorTab.mock.calls.at(-1) as [string];

        expect(callArgument).not.toBe(gitChangesDiffTabPath('repo-1', 'caxri'));
        expect(callArgument).not.toBe(gitPullRequestFileDiffTabPath('repo-1', 'src/index.ts'));
        expect(callArgument).not.toBe(gitPullRequestChangesDiffTabPath('repo-1', 'caxri'));
    });
});
