import { describe, expect, it } from 'vitest';

import {
    gitChangesDiffTabPath,
    gitCommitFileDiffTabPath,
    gitDiffModelPath,
    gitDiffTabLabel,
    gitFileDiffTabPath,
    gitPullRequestChangesDiffTabPath,
    gitPullRequestFileDiffTabPath,
    isGitDiffTabPath,
    parseGitDiffTab,
} from '../git-diff';

describe('Git diff tabs', () => {
    it('round-trips file and repository Changes identities without path collisions', () => {
        const file = gitFileDiffTabPath('repo/1', 'src/a#b?c.ts');
        const changes = gitChangesDiffTabPath('repo/1', 'workspace/name');

        expect(parseGitDiffTab(file)).toEqual({
            kind: 'file',
            path: 'src/a#b?c.ts',
            repositoryId: 'repo/1',
            source: 'working',
        });
        expect(parseGitDiffTab(changes)).toEqual({
            kind: 'changes',
            repositoryId: 'repo/1',
            repositoryName: 'workspace/name',
            source: 'working',
        });
        expect(isGitDiffTabPath('/project/src/a.ts')).toBe(false);
    });

    it('keeps pull request identities distinct from working-tree diffs', () => {
        const file = parseGitDiffTab(gitPullRequestFileDiffTabPath('repo', 'src/file.ts'));
        const changes = parseGitDiffTab(gitPullRequestChangesDiffTabPath('repo', 'workspace'));

        expect(file).toEqual({
            kind: 'file',
            path: 'src/file.ts',
            repositoryId: 'repo',
            source: 'pull-request',
        });
        expect(changes).toEqual({
            kind: 'changes',
            repositoryId: 'repo',
            repositoryName: 'workspace',
            source: 'pull-request',
        });
        expect(gitDiffTabLabel(changes!)).toBe('PR Changes: workspace');
    });

    it('round-trips the bounded show-excluded flag for aggregate diffs', () => {
        const working = gitChangesDiffTabPath('repo/1', 'workspace/name', true);
        const pullRequest = gitPullRequestChangesDiffTabPath('repo', 'workspace', true);

        expect(working).toBe(
            'caxri-git-diff://changes/repo%2F1/workspace%2Fname?showExcluded=true',
        );
        expect(parseGitDiffTab(working)).toEqual({
            kind: 'changes',
            repositoryId: 'repo/1',
            repositoryName: 'workspace/name',
            showExcluded: true,
            source: 'working',
        });
        expect(parseGitDiffTab(pullRequest)).toMatchObject({
            kind: 'changes',
            showExcluded: true,
            source: 'pull-request',
        });
        expect(parseGitDiffTab(`${working}&path=src%2Fsecret.ts`)).toBeUndefined();
        expect(parseGitDiffTab(`${gitFileDiffTabPath('repo', 'src/a.ts')}?showExcluded=true`)).toBe(
            undefined,
        );
    });

    it('round-trips commit file identities with a sha-qualified label', () => {
        const sha = '0123456789abcdef0123456789abcdef01234567';
        const tab = parseGitDiffTab(gitCommitFileDiffTabPath('repo/1', sha, 'src/a#b?c.ts'));

        expect(tab).toEqual({
            kind: 'commit-file',
            path: 'src/a#b?c.ts',
            repositoryId: 'repo/1',
            sha,
            source: 'commit',
        });
        expect(gitDiffTabLabel(tab!)).toBe('a#b?c.ts (0123456)');
        // A malformed sha must not parse into a commit tab.
        expect(parseGitDiffTab(gitCommitFileDiffTabPath('repo/1', 'not-a-sha', 'src/a.ts'))).toBe(
            undefined,
        );
    });

    it('provides readable labels and distinct original and modified Monaco model URIs', () => {
        const tab = parseGitDiffTab(gitFileDiffTabPath('repo', 'src/file.ts'))!;
        const original = gitDiffModelPath('session', 'repo', 'src/file.ts', 'original');
        const modified = gitDiffModelPath('session', 'repo', 'src/file.ts', 'modified');

        expect(gitDiffTabLabel(tab)).toBe('file.ts');
        expect(original).not.toBe(modified);
        expect(original).toMatch(/\/src\/file\.ts$/);
    });
});
