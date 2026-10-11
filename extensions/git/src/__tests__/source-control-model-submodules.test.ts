import './host-api.fixture';

import type { GitCommitDetails, GitPullRequestChanges, GitSummary } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildSourceControlViewModel } from '../source-control-model';

const summary: GitSummary = {
    isRepository: true,
    repositories: [
        {
            id: 'repo-1',
            kind: 'primary',
            name: 'project',
            rootPath: '/authorized/project',
            branch: 'feature/product-extensions',
            head: '0123456789abcdef0123456789abcdef01234567',
            ahead: 1,
            behind: 2,
            additions: 3,
            deletions: 4,
            generation: 7,
            changedFileCount: 1,
            truncated: false,
            files: [
                {
                    path: 'src/extension.ts',
                    index: ' ',
                    workingTree: 'M',
                    kind: 'modified',
                },
            ],
        },
    ],
};

describe('Git source-control view model submodule gitlink rows', () => {
    /**
     * The parent records a submodule as one gitlink change, so the panel used to print it twice in a row: once inside
     * the parent's change list, once as the submodule's own section right below. The gitlink row loses, and every count
     * the caption prints loses with it: otherwise the caption promises a row the list no longer renders.
     */
    it('drops a gitlink row the snapshot already shows as its own repository section', () => {
        const gitlink = {
            path: 'vendor/library',
            index: ' ',
            workingTree: 'M',
            kind: 'modified' as const,
        };
        const readme = {
            path: 'README.md',
            index: ' ',
            workingTree: 'M',
            kind: 'modified' as const,
        };
        const primary = {
            ...summary.repositories[0],
            changedFileCount: 12,
            truncated: true,
            files: [gitlink, readme],
        };
        const submodule = {
            ...summary.repositories[0],
            id: 'repo-submodule',
            kind: 'submodule' as const,
            name: 'library',
            rootPath: '/authorized/project/vendor/library',
            changedFileCount: 0,
            files: [],
        };
        const model = buildSourceControlViewModel({
            mode: 'working',
            summary: { isRepository: true, repositories: [primary, submodule] },
        });

        expect(model.providers[0].groups[0]).toMatchObject({
            count: 11,
            truncationMessage: 'Showing the first 1 of 11 changes',
            resources: [{ path: 'README.md' }],
        });
    });

    /**
     * The submodule's own section shows its own commit or pull request in these modes, not the pointer the parent's
     * moved, so dropping the gitlink row made a pointer-only pull request read as "Pull request has no file changes."
     */
    it('keeps the gitlink row in Commit and Pull Request mode even when the submodule has its own section', () => {
        const submodule = {
            ...summary.repositories[0],
            id: 'repo-submodule',
            kind: 'submodule' as const,
            name: 'library',
            rootPath: '/authorized/project/vendor/library',
            changedFileCount: 0,
            files: [],
        };
        const repositories = [summary.repositories[0], submodule];
        const pullRequest: GitPullRequestChanges = {
            repositoryId: 'repo-1',
            number: 7,
            title: 'Bump library',
            url: 'https://github.com/example/caxri/pull/7',
            baseRefName: 'main',
            headRefName: 'feature/bump-library',
            baseOid: 'a'.repeat(40),
            headOid: 'b'.repeat(40),
            unpushedCommitCount: 0,
            additions: 1,
            deletions: 1,
            files: [{ path: 'vendor/library', index: 'M', workingTree: ' ', kind: 'modified' }],
        };
        const details: GitCommitDetails = {
            commit: {
                sha: summary.repositories[0].head!,
                shortSha: '0123456',
                subject: 'Bump library',
                body: '',
                author: 'Octocat',
                authorEmail: 'octocat@users.noreply.github.com',
                authoredAt: 1_700_000_000_000,
                decorations: [],
                parents: [],
            },
            additions: 1,
            deletions: 1,
            files: [{ path: 'vendor/library', status: 'modified' }],
            filesTruncated: false,
        };

        const pullRequestModel = buildSourceControlViewModel({
            mode: 'pull-request',
            summary: { isRepository: true, repositories },
            pullRequestsByRepository: new Map([['repo-1', pullRequest]]),
        });
        const commitModel = buildSourceControlViewModel({
            mode: 'commit',
            summary: { isRepository: true, repositories },
            detailsByRepository: new Map([['repo-1', details]]),
        });

        for (const model of [pullRequestModel, commitModel])
            expect(model.providers[0].groups[0]).toMatchObject({
                count: 1,
                resources: [{ path: 'vendor/library' }],
            });
    });

    it('keeps the gitlink row for a submodule with no section of its own', () => {
        const primary = {
            ...summary.repositories[0],
            changedFileCount: 1,
            files: [
                {
                    path: 'vendor/library',
                    index: ' ',
                    workingTree: 'M',
                    kind: 'modified' as const,
                },
            ],
        };
        const model = buildSourceControlViewModel({
            mode: 'working',
            summary: { isRepository: true, repositories: [primary] },
        });

        expect(model.providers[0].groups[0]).toMatchObject({
            count: 1,
            resources: [
                { path: 'vendor/library', action: { command: { id: 'caxri.git.openChanges' } } },
            ],
        });
    });
});
