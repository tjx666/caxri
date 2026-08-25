import { describe, expect, it, vi } from 'vitest';

import { createGitRepoDiffActions } from '../use-git-repo-section-controller';

function diffDependencies() {
    return {
        openCommitFile: vi.fn(),
        openPullRequestChanges: vi.fn(),
        openPullRequestFile: vi.fn(),
        openWorkingChanges: vi.fn(),
        openWorkingFile: vi.fn(),
    };
}

describe('Git repository section controller workflows', () => {
    it('routes working tree changes and files to working diff actions', () => {
        const dependencies = diffDependencies();
        const actions = createGitRepoDiffActions(
            {
                headSha: 'a'.repeat(40),
                mode: 'working',
                repositoryId: 'repo-1',
                repositoryName: 'Caxri',
            },
            dependencies,
        );

        actions.openChanges();
        actions.openFile('src/app.ts');

        expect(dependencies.openWorkingChanges).toHaveBeenCalledWith('repo-1', 'Caxri');
        expect(dependencies.openWorkingFile).toHaveBeenCalledWith('repo-1', 'src/app.ts');
        expect(dependencies.openCommitFile).not.toHaveBeenCalled();
        expect(dependencies.openPullRequestChanges).not.toHaveBeenCalled();
    });

    it('routes pull request changes and files to pull request diff actions', () => {
        const dependencies = diffDependencies();
        const actions = createGitRepoDiffActions(
            {
                headSha: 'a'.repeat(40),
                mode: 'pull-request',
                repositoryId: 'repo-1',
                repositoryName: 'Caxri',
            },
            dependencies,
        );

        actions.openChanges();
        actions.openFile('src/app.ts');

        expect(dependencies.openPullRequestChanges).toHaveBeenCalledWith('repo-1', 'Caxri');
        expect(dependencies.openPullRequestFile).toHaveBeenCalledWith('repo-1', 'src/app.ts');
        expect(dependencies.openWorkingChanges).not.toHaveBeenCalled();
    });

    it('opens commit files only when HEAD is available', () => {
        const dependencies = diffDependencies();
        const withHead = createGitRepoDiffActions(
            {
                headSha: 'a'.repeat(40),
                mode: 'commit',
                repositoryId: 'repo-1',
                repositoryName: 'Caxri',
            },
            dependencies,
        );
        const withoutHead = createGitRepoDiffActions(
            {
                headSha: undefined,
                mode: 'commit',
                repositoryId: 'repo-1',
                repositoryName: 'Caxri',
            },
            dependencies,
        );

        withHead.openFile('src/app.ts');
        withoutHead.openFile('src/empty.ts');
        withHead.openChanges();

        expect(dependencies.openCommitFile).toHaveBeenCalledOnce();
        expect(dependencies.openCommitFile).toHaveBeenCalledWith(
            'repo-1',
            'a'.repeat(40),
            'src/app.ts',
        );
        expect(dependencies.openWorkingChanges).not.toHaveBeenCalled();
        expect(dependencies.openPullRequestChanges).not.toHaveBeenCalled();
    });
});
