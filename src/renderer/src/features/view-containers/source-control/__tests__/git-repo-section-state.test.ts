import type { GitDiffTab } from '@shared/git-diff';
import type { GitFileStatus, GitPullRequestChanges } from '@shared/types';
import { describe, expect, it } from 'vitest';

import {
    gitRepoDisplayedCount,
    gitRepoEmptyMessage,
    gitRepoFilesForMode,
    selectedGitRepoPath,
    shouldToastGitRepoDetailError,
} from '../git-repo-section-state';

const workingFile: GitFileStatus = {
    index: ' ',
    kind: 'modified',
    path: 'src/app.ts',
    workingTree: 'M',
};

describe('Git repository section state', () => {
    it('projects files and counts from the active panel mode', () => {
        const pullRequest: GitPullRequestChanges = {
            additions: 1,
            baseOid: 'a'.repeat(40),
            baseRefName: 'main',
            deletions: 0,
            files: [{ ...workingFile, path: 'pr.ts' }],
            headOid: 'b'.repeat(40),
            headRefName: 'feature/panel',
            number: 42,
            repositoryId: 'repo-a',
            title: 'Preserve Source Control parity',
            url: 'https://github.com/tjx666/caxri/pull/42',
        };

        expect(gitRepoFilesForMode('working', [workingFile], undefined, pullRequest)).toEqual([
            workingFile,
        ]);
        expect(gitRepoFilesForMode('pull-request', [workingFile], undefined, pullRequest)).toEqual(
            pullRequest.files,
        );
        expect(gitRepoDisplayedCount('working', 2_500, [workingFile])).toBe(2_500);
        expect(gitRepoDisplayedCount('pull-request', 2_500, pullRequest.files)).toBe(1);
    });

    it('selects a diff only when repository, mode, and commit identity all match', () => {
        const workingDiff: GitDiffTab = {
            kind: 'file',
            path: 'src/app.ts',
            repositoryId: 'repo-a',
            source: 'working',
        };
        const commitDiff: GitDiffTab = {
            kind: 'commit-file',
            path: 'src/app.ts',
            repositoryId: 'repo-a',
            sha: 'a'.repeat(40),
            source: 'commit',
        };

        expect(selectedGitRepoPath('working', workingDiff, 'repo-a', undefined)).toBe('src/app.ts');
        expect(
            selectedGitRepoPath('pull-request', workingDiff, 'repo-a', undefined),
        ).toBeUndefined();
        expect(selectedGitRepoPath('commit', commitDiff, 'repo-a', 'a'.repeat(40))).toBe(
            'src/app.ts',
        );
        expect(selectedGitRepoPath('commit', commitDiff, 'repo-a', 'b'.repeat(40))).toBeUndefined();
    });

    it('preserves every loading, error, empty, and no-commit message', () => {
        expect(
            gitRepoEmptyMessage({
                headSha: undefined,
                latestCommit: undefined,
                latestCommitError: false,
                mode: 'working',
                pullRequest: undefined,
                pullRequestError: false,
            }),
        ).toBe('Working tree clean.');
        expect(
            gitRepoEmptyMessage({
                headSha: undefined,
                latestCommit: undefined,
                latestCommitError: false,
                mode: 'commit',
                pullRequest: undefined,
                pullRequestError: false,
            }),
        ).toBe('No commits yet.');
        expect(
            gitRepoEmptyMessage({
                headSha: 'a'.repeat(40),
                latestCommit: undefined,
                latestCommitError: true,
                mode: 'commit',
                pullRequest: undefined,
                pullRequestError: false,
            }),
        ).toBe('Unable to load the last commit.');
        expect(
            gitRepoEmptyMessage({
                headSha: 'a'.repeat(40),
                latestCommit: undefined,
                latestCommitError: false,
                mode: 'commit',
                pullRequest: undefined,
                pullRequestError: false,
            }),
        ).toBe('Loading last commit…');
        expect(
            gitRepoEmptyMessage({
                headSha: 'a'.repeat(40),
                latestCommit: undefined,
                latestCommitError: false,
                mode: 'pull-request',
                pullRequest: null,
                pullRequestError: false,
            }),
        ).toBe('No pull request for this branch.');
        expect(
            gitRepoEmptyMessage({
                headSha: 'a'.repeat(40),
                latestCommit: undefined,
                latestCommitError: false,
                mode: 'pull-request',
                pullRequest: undefined,
                pullRequestError: true,
            }),
        ).toBe('Unable to load pull request changes.');
    });

    it('toasts only when a detail refresh error is hidden behind retained files', () => {
        expect(
            shouldToastGitRepoDetailError({
                active: true,
                displayedFileCount: 0,
                isError: true,
            }),
        ).toBe(false);
        expect(
            shouldToastGitRepoDetailError({
                active: true,
                displayedFileCount: 1,
                isError: true,
            }),
        ).toBe(true);
        expect(
            shouldToastGitRepoDetailError({
                active: false,
                displayedFileCount: 1,
                isError: true,
            }),
        ).toBe(false);
    });
});
