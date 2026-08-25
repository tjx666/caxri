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

describe('Git source-control view model', () => {
    it('keeps resource identity bounded without changing the authorized Git path', () => {
        const longPath = `${'nested/'.repeat(2_000)}file.ts`;
        const longPathSummary: GitSummary = {
            ...summary,
            repositories: [
                {
                    ...summary.repositories[0],
                    files: [
                        {
                            path: longPath,
                            index: ' ',
                            workingTree: 'M',
                            kind: 'modified',
                        },
                    ],
                },
            ],
        };

        const model = buildSourceControlViewModel({ mode: 'working', summary: longPathSummary });
        const resource = model.providers[0].groups[0].resources[0];

        expect(resource.id.length).toBeLessThanOrEqual(480);
        expect(resource.path.length).toBeLessThanOrEqual(4_096);
        expect(resource.tooltip.length).toBeLessThanOrEqual(4_096);
        expect(resource.accessibilityLabel.length).toBeLessThanOrEqual(1_024);
        expect(resource.editorResource).toBeUndefined();
        expect(resource.action).toBeUndefined();
        expect(resource.actions?.[0].command.arguments).toEqual(['repo-1', longPath]);
        expect(resource.actions?.[0].label.length).toBeLessThanOrEqual(1_024);
    });

    it('builds Git-owned modes, repository groups, resources, counts, and command bindings from raw Runtime data', () => {
        const model = buildSourceControlViewModel({ mode: 'working', summary });

        expect(model).toMatchObject({
            title: 'Source Control',
            modes: [
                {
                    id: 'working',
                    label: 'Working Tree Changes',
                    command: { id: 'caxri.git.workingTree' },
                },
                {
                    id: 'commit',
                    label: 'Last Commit Changes',
                    command: { id: 'caxri.git.lastCommit' },
                },
                {
                    id: 'pull-request',
                    label: 'Pull Request Changes',
                    command: { id: 'caxri.git.pullRequest' },
                },
            ],
            selectedModeId: 'working',
            providers: [{ id: 'repo-1', label: 'project' }],
        });
        expect(model.providers[0].description).toContain('feature/product-extensions');
        const group = model.providers[0].groups[0];
        expect(group).toMatchObject({ id: 'repo-1:changes', label: 'Changes', count: 1 });
        expect(group.resources[0]).toMatchObject({
            id: 'repo-1:src/extension.ts',
            label: 'extension.ts',
            description: 'M',
            icon: { kind: 'file-type', name: 'extension.ts' },
            action: { command: { id: 'caxri.git.openChanges' } },
        });
        const commandIds = [
            ...model.providers[0].actions,
            ...model.providers[0].groups[0].actions,
        ].map(({ command }) => command.id);
        expect(commandIds).toContain('caxri.git.sync');
        expect(commandIds).toContain('caxri.git.discardAll');
    });

    it('projects Last Commit details, file status, diff resources, and truncated state', () => {
        const details: GitCommitDetails = {
            commit: {
                sha: summary.repositories[0].head!,
                shortSha: '0123456',
                subject: 'Move Git projection',
                body: '',
                author: 'Octocat',
                authorEmail: 'octocat@users.noreply.github.com',
                authoredAt: 1_700_000_000_000,
                decorations: [],
                parents: [],
            },
            additions: 2,
            deletions: 1,
            files: [
                {
                    path: 'src/new-name.ts',
                    previousPath: 'src/old-name.ts',
                    status: 'renamed',
                },
            ],
            filesTruncated: true,
        };
        const model = buildSourceControlViewModel({
            mode: 'commit',
            summary,
            detailsByRepository: new Map([['repo-1', details]]),
        });

        expect(model.providers[0]).toMatchObject({
            description: '0123456 Move Git projection',
            actions: [],
            groups: [
                {
                    label: 'Commit 0123456',
                    count: 1,
                    truncationMessage: 'Showing the first 1 files of this commit',
                    resources: [{ label: 'new-name.ts', description: 'R' }],
                },
            ],
        });
        expect(model.providers[0].groups[0].resources[0].editorResource).toContain(
            'caxri-git-diff://commit-file/repo-1/',
        );
    });

    it('projects Pull Request metadata, counts, actions, and empty state', () => {
        const pullRequest: GitPullRequestChanges = {
            repositoryId: 'repo-1',
            number: 42,
            title: 'Make Source Control generic',
            url: 'https://github.com/example/caxri/pull/42',
            baseRefName: 'main',
            headRefName: 'feature/extensions',
            baseOid: 'a'.repeat(40),
            headOid: 'b'.repeat(40),
            additions: 5,
            deletions: 2,
            files: [
                {
                    path: 'extensions/git/src/extension.ts',
                    index: 'M',
                    workingTree: ' ',
                    kind: 'modified',
                },
            ],
        };
        const model = buildSourceControlViewModel({
            mode: 'pull-request',
            summary,
            pullRequestsByRepository: new Map([['repo-1', pullRequest]]),
        });

        expect(model.providers[0]).toMatchObject({
            description: '#42 Make Source Control generic',
            descriptionAccessibilityLabel: 'Pull request #42: Make Source Control generic',
            groups: [
                {
                    label: 'PR #42 Changes',
                    count: 1,
                    resources: [{}],
                },
            ],
        });
        expect(model.providers[0].groups[0].resources[0].editorResource).toContain(
            'caxri-git-diff://pr-file/repo-1/',
        );
        const openAction = model.providers[0].groups[0].actions[0];
        expect(openAction).toMatchObject({
            label: 'Open Pull Request Changes',
            command: { id: 'caxri.git.openChanges' },
        });
        expect(openAction.command.arguments?.[0]).toEqual(expect.any(String));

        const empty = buildSourceControlViewModel({
            mode: 'pull-request',
            summary,
            pullRequestsByRepository: new Map([['repo-1', null]]),
        });
        expect(empty.providers[0]?.groups[0]?.emptyMessage).toBe(
            'No pull request for this branch.',
        );
    });

    it('binds submodule navigation and preserves working-tree truncation metadata', () => {
        const primary = {
            ...summary.repositories[0],
            changedFileCount: 12,
            truncated: true,
            files: [
                {
                    path: 'vendor/library',
                    index: ' ',
                    workingTree: 'M',
                    kind: 'modified' as const,
                },
            ],
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
            truncationMessage: 'Showing the first 1 of 12 changes',
            resources: [
                {
                    description: 'submodule',
                    navigationTargetId: 'repo-submodule',
                    action: {
                        command: {
                            id: 'caxri.git.openSubmodule',
                            arguments: ['repo-submodule'],
                        },
                    },
                },
            ],
        });
    });

    it('owns Git-specific top-level error copy', () => {
        const model = buildSourceControlViewModel({
            mode: 'working',
            summary: {
                isRepository: false,
                repositories: [],
                error: 'The Project root is not a Git repository.',
            },
        });

        expect(model.emptyMessage).toBe('This folder is not a Git repository.');
    });
});
