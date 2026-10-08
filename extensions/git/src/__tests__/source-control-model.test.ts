import './host-api.fixture';

import type { GitCommitDetails, GitPullRequestChanges, GitSummary } from 'caxri';
import { ProjectStatusSummaryErrorMessage } from 'caxri';
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
        expect(model.providers[0].description).toBe('feature/product-extensions');
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

    it('uses the deepest repository for the active file history', () => {
        const nestedRepo = {
            ...summary.repositories[0],
            id: 'repo-nested',
            kind: 'submodule' as const,
            name: 'library',
            rootPath: '/authorized/project/vendor/library',
        };
        const model = buildSourceControlViewModel({
            activeResource: '/authorized/project/vendor/library/src/nested.ts',
            mode: 'working',
            summary: {
                isRepository: true,
                repositories: [summary.repositories[0], nestedRepo],
            },
        });

        expect(model.fileHistory).toMatchObject({
            label: 'File History',
            description: 'nested.ts',
            path: 'src/nested.ts',
            tooltip: 'src/nested.ts',
            history: {
                id: 'repo-nested',
                itemActivation: 'action',
            },
        });
    });

    it('publishes each repository root as an explicit provider field', () => {
        const nestedRepo = {
            ...summary.repositories[0],
            id: 'repo-nested',
            kind: 'submodule' as const,
            name: 'library',
            rootPath: '/authorized/project/vendor/library',
        };
        const model = buildSourceControlViewModel({
            mode: 'working',
            summary: {
                isRepository: true,
                repositories: [summary.repositories[0], nestedRepo],
            },
        });

        expect(model.providers.map((provider) => provider.rootPath)).toEqual([
            '/authorized/project',
            '/authorized/project/vendor/library',
        ]);
    });

    it('preserves a macOS backslash filename in the history path', () => {
        const model = buildSourceControlViewModel({
            activeResource: String.raw`/authorized/project/src/a\b.ts`,
            mode: 'working',
            summary,
        });

        expect(model.fileHistory).toMatchObject({
            description: String.raw`a\b.ts`,
            path: String.raw`src/a\b.ts`,
            tooltip: String.raw`src/a\b.ts`,
        });
    });

    it.each([
        ['no active resource', undefined],
        ['an active resource outside the repositories', '/outside/project/file.ts'],
    ])('omits File History for %s', (_scenario, activeResource) => {
        const model = buildSourceControlViewModel({ activeResource, mode: 'working', summary });

        expect(model.fileHistory).toBeUndefined();
    });

    it('keeps repository Commits as a non-action history descriptor', () => {
        const model = buildSourceControlViewModel({ mode: 'working', summary });

        expect(model.providers[0].history).toMatchObject({
            id: 'repo-1',
            label: 'Commits',
        });
        expect(model.providers[0].history?.itemActivation).toBeUndefined();
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
            // The branch keeps the row's description in every mode; the commit it is showing moves to the hover.
            description: 'feature/product-extensions',
            descriptionTooltip:
                'feature/product-extensions · 1 ahead, 2 behind · 0123456 Move Git projection',
            // The repository's own uncommitted work is invisible in this mode, so the row keeps a route back to it.
            uncommittedNotice: {
                modeId: 'working',
                accessibilityLabel: '1 uncommitted change in project',
            },
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
            unpushedCommitCount: 2,
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
            description: 'feature/product-extensions',
            // Command-clicking the provider row or its group caption opens this, so the panel spends no row width on a link glyph.
            externalLink: {
                url: 'https://github.com/example/caxri/pull/42',
                label: 'Open pull request #42 on the web',
            },
            descriptionAccessibilityLabel:
                'feature/product-extensions, 1 ahead, 2 behind, Pull request #42 into main: Make Source Control generic, 2 local commits are not included in pull request #42',
            descriptionTooltip:
                'feature/product-extensions · 1 ahead, 2 behind · Pull request #42 into main: Make Source Control generic · 2 local commits are not included in pull request #42',
            countLabel: ' · 1 · 2 unpushed · 1 uncommitted',
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

        const published = buildSourceControlViewModel({
            mode: 'pull-request',
            summary,
            pullRequestsByRepository: new Map([
                ['repo-1', { ...pullRequest, unpushedCommitCount: 0 }],
            ]),
        });
        expect(published.providers[0].countLabel).not.toContain('unpushed');
        expect(published.providers[0].descriptionTooltip).not.toContain('not included');

        const longTitle = buildSourceControlViewModel({
            mode: 'pull-request',
            summary,
            pullRequestsByRepository: new Map([
                ['repo-1', { ...pullRequest, title: 'x'.repeat(3_970) }],
            ]),
        });
        expect(longTitle.providers[0].descriptionAccessibilityLabel.length).toBeLessThanOrEqual(
            4_096,
        );
        expect(longTitle.providers[0].descriptionTooltip.length).toBeLessThanOrEqual(4_096);
        expect(longTitle.providers[0].descriptionTooltip).toContain(
            '2 local commits are not included in pull request #42',
        );

        const singular = buildSourceControlViewModel({
            mode: 'pull-request',
            summary,
            pullRequestsByRepository: new Map([
                ['repo-1', { ...pullRequest, unpushedCommitCount: 1 }],
            ]),
        });
        expect(singular.providers[0].descriptionTooltip).toContain(
            '1 local commit is not included in pull request #42',
        );
    });

    it('reports uncommitted work the Pull Request view is hiding, and stays quiet when there is none', () => {
        const dirty = buildSourceControlViewModel({
            mode: 'pull-request',
            summary: {
                ...summary,
                repositories: [{ ...summary.repositories[0], changedFileCount: 3 }],
            },
            pullRequestsByRepository: new Map([['repo-1', null]]),
        });
        expect(dirty.providers[0].countLabel).toContain('3 uncommitted');
        expect(dirty.providers[0].uncommittedNotice).toEqual({
            modeId: 'working',
            accessibilityLabel: '3 uncommitted changes in project',
            tooltip: '3 uncommitted changes in project. Show Working Tree Changes.',
        });
        // The notice names a mode the panel actually offers, or the renderer has nothing to switch to.
        expect(dirty.modes.map((mode) => mode.id)).toContain(
            dirty.providers[0].uncommittedNotice?.modeId,
        );
        // A repository with no pull request must not present its zero as a clean working tree.
        expect(dirty.providers[0].groups[0].label).toBe('Pull Request Changes');

        const clean = buildSourceControlViewModel({
            mode: 'pull-request',
            summary: {
                ...summary,
                repositories: [{ ...summary.repositories[0], changedFileCount: 0, files: [] }],
            },
            pullRequestsByRepository: new Map([['repo-1', null]]),
        });
        expect(clean.providers[0].countLabel).not.toContain('uncommitted');
        expect(clean.providers[0].uncommittedNotice).toBeUndefined();
    });

    it('leaves Working Tree mode without an uncommitted-work notice, because it is the notice', () => {
        const model = buildSourceControlViewModel({ mode: 'working', summary });
        expect(model.providers[0].countLabel).not.toContain('uncommitted');
        expect(model.providers[0].uncommittedNotice).toBeUndefined();
    });

    /**
     * VS Code's own glyph vocabulary, so a repository row reads the same in both apps: `repo` for a checkout,
     * `worktree` for a linked worktree, `archive` for a submodule. A nested repository is still a checkout, so it keeps
     * `repo`.
     */
    it('names each repository kind with the VS Code codicon for it', () => {
        const model = buildSourceControlViewModel({
            mode: 'working',
            summary: {
                isRepository: true,
                repositories: (['primary', 'worktree', 'nested', 'submodule'] as const).map(
                    (kind) => ({ ...summary.repositories[0], id: `repo-${kind}`, kind }),
                ),
            },
        });

        expect(model.providers.map((provider) => provider.icon)).toEqual([
            { kind: 'theme', id: 'repo' },
            { kind: 'theme', id: 'worktree' },
            { kind: 'theme', id: 'repo' },
            { kind: 'theme', id: 'archive' },
        ]);
    });

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

    it('owns Git-specific top-level error copy', () => {
        const model = buildSourceControlViewModel({
            mode: 'working',
            summary: {
                isRepository: false,
                repositories: [],
                error: ProjectStatusSummaryErrorMessage.missingGitRepository,
            },
        });

        expect(model.emptyMessage).toBe('This folder is not a Git repository.');
        expect(model.emptyKind).toBe('no-repository');
    });

    it('does not mislabel an unknown Git failure as a missing repository', () => {
        const model = buildSourceControlViewModel({
            mode: 'working',
            summary: {
                isRepository: false,
                repositories: [],
                error: 'The Git operation failed. Open Logs for details.',
            },
        });

        expect(model.emptyKind).toBe('unavailable');
        expect(model.emptyMessage).toBe(
            'Source Control is unavailable right now. The Git operation failed. Open Logs for details.',
        );
    });

    it('filters working files while preserving totals and exposes an accessible toggle', () => {
        const filteredSummary: GitSummary = {
            ...summary,
            repositories: [
                {
                    ...summary.repositories[0],
                    changedFileCount: 3,
                    files: [
                        ...summary.repositories[0].files,
                        {
                            path: 'src/extension.test.ts',
                            index: ' ',
                            workingTree: 'M',
                            kind: 'modified',
                        },
                        {
                            path: 'src/__tests__/fixture.ts',
                            index: ' ',
                            workingTree: 'M',
                            kind: 'modified',
                        },
                    ],
                },
            ],
        };
        const excludePatterns = {
            '**/*.test.*': true,
            '**/__tests__/**': true,
        };

        const hidden = buildSourceControlViewModel({
            excludePatterns,
            mode: 'working',
            summary: filteredSummary,
        });
        expect(hidden.headerActions?.[0]).toMatchObject({
            icon: { kind: 'theme', id: 'eye' },
            label: 'Show excluded files (2)',
            pressed: false,
            tooltip: 'Show excluded files (2)',
        });
        expect(hidden.providers[0].groups[0]).toMatchObject({
            count: 3,
            hiddenCount: 2,
            resources: [{ label: 'extension.ts' }],
        });
        expect(hidden.providers[0].groups[0].actions[0]).toMatchObject({
            disabled: true,
            tooltip: 'Show excluded files to discard all changes.',
        });

        const shown = buildSourceControlViewModel({
            excludePatterns,
            mode: 'working',
            isShowingExcluded: true,
            summary: filteredSummary,
        });
        expect(shown.headerActions?.[0]).toMatchObject({
            icon: { kind: 'theme', id: 'eye-off' },
            label: 'Hide excluded files (2)',
            pressed: true,
        });
        expect(shown.providers[0].groups[0].resources).toHaveLength(3);
        expect(shown.providers[0].groups[0].hiddenCount).toBeUndefined();
        expect(shown.providers[0].groups[0].actions[0].disabled).toBe(false);
        expect(shown.providers[0].groups[0].actions[1].command.arguments?.[0]).toContain(
            '?showExcluded=true',
        );
    });

    it('offers the excluded-files toggle only when it would change what the panel shows', () => {
        const excludePatterns = { '**/*.test.*': true };

        const nothingHidden = buildSourceControlViewModel({
            excludePatterns,
            mode: 'working',
            summary,
        });
        expect(nothingHidden.headerActions).toBeUndefined();

        const shown = buildSourceControlViewModel({
            excludePatterns,
            isShowingExcluded: true,
            mode: 'working',
            summary,
        });
        expect(shown.headerActions?.[0]).toMatchObject({ label: 'Hide excluded files (0)' });

        const truncated = buildSourceControlViewModel({
            excludePatterns,
            mode: 'working',
            summary: {
                ...summary,
                repositories: [
                    {
                        ...summary.repositories[0],
                        changedFileCount: 12,
                        truncated: true,
                    },
                ],
            },
        });
        expect(truncated.headerActions?.[0]).toMatchObject({
            label: 'Show excluded files (0)',
        });

        const disabledPatterns = buildSourceControlViewModel({
            excludePatterns: { '**/*.test.*': false },
            mode: 'working',
            summary: {
                ...summary,
                repositories: [{ ...summary.repositories[0], truncated: true }],
            },
        });
        expect(disabledPatterns.headerActions).toBeUndefined();
    });

    it('uses the excluded-only empty state for working, commit, and pull-request changes', () => {
        const testFile = {
            path: 'src/feature.spec.ts',
            index: 'M',
            workingTree: ' ',
            kind: 'modified' as const,
        };
        const excludePatterns = { '**/*.spec.*': true };
        const working = buildSourceControlViewModel({
            excludePatterns,
            mode: 'working',
            summary: {
                ...summary,
                repositories: [
                    {
                        ...summary.repositories[0],
                        changedFileCount: 1,
                        files: [testFile],
                    },
                ],
            },
        });
        const details: GitCommitDetails = {
            commit: {
                sha: summary.repositories[0].head!,
                shortSha: '0123456',
                subject: 'Test only',
                body: '',
                author: 'Caxri',
                authorEmail: 'caxri@example.com',
                authoredAt: 1,
                decorations: [],
                parents: [],
            },
            additions: 1,
            deletions: 0,
            files: [{ path: testFile.path, status: 'modified' }],
            filesTruncated: false,
        };
        const commit = buildSourceControlViewModel({
            detailsByRepository: new Map([['repo-1', details]]),
            excludePatterns,
            mode: 'commit',
            summary,
        });
        const pullRequest = buildSourceControlViewModel({
            excludePatterns,
            mode: 'pull-request',
            pullRequestsByRepository: new Map([
                [
                    'repo-1',
                    {
                        repositoryId: 'repo-1',
                        number: 1,
                        title: 'Test only',
                        url: 'https://github.com/example/caxri/pull/1',
                        baseRefName: 'main',
                        headRefName: 'tests',
                        baseOid: 'a'.repeat(40),
                        headOid: 'b'.repeat(40),
                        unpushedCommitCount: 0,
                        additions: 1,
                        deletions: 0,
                        files: [testFile],
                    },
                ],
            ]),
            summary,
        });

        for (const model of [working, commit, pullRequest])
            expect(model.providers[0].groups[0]).toMatchObject({
                count: 1,
                emptyMessage: '1 excluded file hidden.',
                hiddenCount: 1,
                resources: [],
            });
    });
});
