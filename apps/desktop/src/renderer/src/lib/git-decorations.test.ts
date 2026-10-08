import type { GitFileStatus, GitSummary } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    buildGitChildRepoIndex,
    buildGitDecorationIndex,
    gitChildRepoDescription,
    gitDecorationClassName,
} from './git-decorations';

function file(overrides: Partial<GitFileStatus> & Pick<GitFileStatus, 'path'>): GitFileStatus {
    return { index: ' ', kind: 'modified', workingTree: 'M', ...overrides };
}

function summary(files: GitFileStatus[], rootPath = '/repo'): GitSummary {
    return {
        isRepository: true,
        repositories: [
            {
                id: 'repo',
                kind: 'primary',
                name: 'repo',
                rootPath,
                branch: 'main',
                ahead: 0,
                behind: 0,
                additions: 0,
                deletions: 0,
                generation: 1,
                changedFileCount: files.length,
                truncated: false,
                files,
            },
        ],
    };
}

/**
 * A Project whose Git summary reports several repositories. `repositories[0]` is the Workbench Root's own; the rest are
 * children discovered inside it.
 */
function nestedSummary(
    repositories: ReadonlyArray<{
        files: GitFileStatus[];
        kind?: GitSummary['repositories'][number]['kind'];
        rootPath: string;
    }>,
): GitSummary {
    return {
        isRepository: true,
        repositories: repositories.map((repo, order) => ({
            ...summary(repo.files, repo.rootPath).repositories[0],
            id: `repo-${order}`,
            kind: repo.kind ?? (order === 0 ? 'primary' : 'submodule'),
        })),
    };
}

/**
 * A parent repository reports a submodule whose recorded commit moved as one change entry naming the submodule
 * directory itself: a gitlink. The path is a folder in the tree, not a file.
 */
function gitlink(path: string): GitFileStatus {
    return file({ path, index: 'M', workingTree: ' ' });
}

describe('buildGitDecorationIndex', () => {
    it('decorates a changed file with its kind and status letter', () => {
        const index = buildGitDecorationIndex(summary([file({ path: 'src/app.ts' })]));

        expect(index.get('/repo/src/app.ts')).toEqual({ kind: 'modified', letter: 'M' });
    });

    it('provides the same exact-file decoration to search and breadcrumb paths', () => {
        const index = buildGitDecorationIndex(
            summary([
                file({ path: 'src/edited.ts' }),
                file({ path: 'src/new.ts', index: '?', kind: 'untracked', workingTree: '?' }),
            ]),
        );
        const searchMatchPath = '/repo/src/edited.ts';
        const openEditorPath = '/repo/src/edited.ts';
        const pickerSiblingPath = '/repo/src/new.ts';

        expect(index.get(searchMatchPath)).toBe(index.get(openEditorPath));
        expect(index.get(openEditorPath)).toEqual({ kind: 'modified', letter: 'M' });
        expect(index.get(pickerSiblingPath)).toEqual({ kind: 'untracked', letter: '?' });
        expect(index.get('/repo/src/clean.ts')).toBeUndefined();
        expect(index.get('/repo/src')).toEqual({ kind: 'modified' });
    });

    it('prefers the staged column over the working-tree one for the letter', () => {
        const index = buildGitDecorationIndex(
            summary([file({ path: 'src/app.ts', index: 'A', kind: 'added', workingTree: 'M' })]),
        );

        expect(index.get('/repo/src/app.ts')?.letter).toBe('A');
    });

    it('rolls a change up through its ancestor directories without a letter', () => {
        const index = buildGitDecorationIndex(summary([file({ path: 'src/lib/app.ts' })]));

        expect(index.get('/repo/src/lib')).toEqual({ kind: 'modified' });
        expect(index.get('/repo/src')).toEqual({ kind: 'modified' });
    });

    it('never decorates the repository root itself', () => {
        const index = buildGitDecorationIndex(summary([file({ path: 'src/app.ts' })]));

        expect(index.has('/repo')).toBe(false);
    });

    it('gives a directory the most severe change beneath it, whatever order they arrive in', () => {
        const conflict = file({
            path: 'src/conflict.ts',
            index: 'U',
            kind: 'conflicted',
            workingTree: 'U',
        });
        const edit = file({ path: 'src/edited.ts' });

        // Both orders, because the rollup walks ancestors incrementally and stops early on an already-severe one.
        expect(buildGitDecorationIndex(summary([conflict, edit])).get('/repo/src')?.kind).toBe(
            'conflicted',
        );
        expect(buildGitDecorationIndex(summary([edit, conflict])).get('/repo/src')?.kind).toBe(
            'conflicted',
        );
    });

    it('ranks an untracked file below every tracked change on a shared directory', () => {
        const index = buildGitDecorationIndex(
            summary([
                file({ path: 'src/new.ts', index: '?', kind: 'untracked', workingTree: '?' }),
                file({ path: 'src/edited.ts' }),
            ]),
        );

        expect(index.get('/repo/src')?.kind).toBe('modified');
    });

    it('drops a repository-relative path that tries to escape its root', () => {
        const index = buildGitDecorationIndex(summary([file({ path: '../outside.ts' })]));

        expect(index.size).toBe(0);
    });

    it('is empty outside a repository', () => {
        expect(buildGitDecorationIndex(undefined).size).toBe(0);
        expect(buildGitDecorationIndex({ isRepository: false, repositories: [] }).size).toBe(0);
    });

    it('returns the previous index unchanged when Git reports the same working tree', () => {
        const previous = buildGitDecorationIndex(summary([file({ path: 'src/app.ts' })]));
        const restated = summary([file({ path: 'src/app.ts' })]);

        expect(buildGitDecorationIndex(restated, previous)).toBe(previous);
    });

    it('keeps the object identity of entries whose decoration did not change', () => {
        const previous = buildGitDecorationIndex(summary([file({ path: 'src/app.ts' })]));
        const next = buildGitDecorationIndex(
            summary([
                file({ path: 'src/app.ts' }),
                file({ path: 'docs/readme.md', index: '?', kind: 'untracked', workingTree: '?' }),
            ]),
            previous,
        );

        expect(next).not.toBe(previous);
        // An unchanged row must not re-render just because another file changed elsewhere.
        expect(next.get('/repo/src/app.ts')).toBe(previous.get('/repo/src/app.ts'));
        expect(next.get('/repo/docs')).toEqual({ kind: 'untracked' });
    });

    /**
     * The reason this rollup exists: with `packages/` collapsed, a submodule's twelve edits are invisible if
     * propagation stops at the submodule's own root.
     */
    it('rolls a change inside a child repository up to that root and on through its ancestors', () => {
        const index = buildGitDecorationIndex(
            nestedSummary([
                { files: [], rootPath: '/repo' },
                { files: [file({ path: 'src/app.ts' })], rootPath: '/repo/packages/foo' },
            ]),
        );

        expect(index.get('/repo/packages/foo/src/app.ts')).toEqual({
            kind: 'modified',
            letter: 'M',
        });
        expect(index.get('/repo/packages/foo/src')).toEqual({ kind: 'modified' });
        expect(index.get('/repo/packages/foo')).toEqual({ kind: 'modified' });
        expect(index.get('/repo/packages')).toEqual({ kind: 'modified' });
        // Only the Workbench Root's own repository root stays undecorated.
        expect(index.has('/repo')).toBe(false);
    });

    it('keeps climbing through a repository nested inside another child repository', () => {
        const index = buildGitDecorationIndex(
            nestedSummary([
                { files: [], rootPath: '/repo' },
                { files: [], rootPath: '/repo/packages/foo' },
                {
                    files: [file({ path: 'app.ts' })],
                    kind: 'nested',
                    rootPath: '/repo/packages/foo/vendor/bar',
                },
            ]),
        );

        expect(index.get('/repo/packages/foo/vendor/bar')).toEqual({ kind: 'modified' });
        expect(index.get('/repo/packages/foo/vendor')).toEqual({ kind: 'modified' });
        expect(index.get('/repo/packages/foo')).toEqual({ kind: 'modified' });
        expect(index.get('/repo/packages')).toEqual({ kind: 'modified' });
        expect(index.has('/repo')).toBe(false);
    });

    /**
     * Two writers reach the child root: the parent's gitlink entry and the child's own contents climbing to it. Which
     * runs first is only the order `summary.repositories` happens to hold, so both orders must land on the same row.
     */
    it('merges a gitlink and the child repository’s own changes the same way in either order', () => {
        const parent = {
            files: [gitlink('packages/foo')],
            rootPath: '/repo',
        };
        const child = {
            files: [file({ path: 'src/app.ts', index: 'U', kind: 'conflicted', workingTree: 'U' })],
            rootPath: '/repo/packages/foo',
        };

        for (const order of [
            [parent, child],
            [child, { ...parent, kind: 'primary' as const }],
        ]) {
            const index = buildGitDecorationIndex(nestedSummary(order));

            // The louder of the two wins, and the row is a folder, so it carries no letter.
            expect(index.get('/repo/packages/foo')).toEqual({ kind: 'conflicted' });
            expect(index.get('/repo/packages')).toEqual({ kind: 'conflicted' });
        }
    });

    it('drops the gitlink letter even when the child repository has no changes of its own', () => {
        const index = buildGitDecorationIndex(
            nestedSummary([
                { files: [gitlink('packages/foo')], rootPath: '/repo' },
                { files: [], rootPath: '/repo/packages/foo' },
            ]),
        );

        expect(index.get('/repo/packages/foo')).toEqual({ kind: 'modified' });
    });

    it('stops at a linked worktree root, which is the Workbench Root’s own checkout', () => {
        const index = buildGitDecorationIndex(
            nestedSummary([
                { files: [], kind: 'worktree', rootPath: '/worktree' },
                { files: [file({ path: 'app.ts' })], rootPath: '/worktree/vendor/bar' },
            ]),
        );

        expect(index.get('/worktree/vendor/bar')).toEqual({ kind: 'modified' });
        expect(index.get('/worktree/vendor')).toEqual({ kind: 'modified' });
        expect(index.has('/worktree')).toBe(false);
    });

    it('does not treat a sibling directory that shares the root’s name prefix as being inside it', () => {
        const index = buildGitDecorationIndex(
            nestedSummary([
                { files: [], rootPath: '/repo' },
                { files: [file({ path: 'app.ts' })], rootPath: '/repo-vendor/bar' },
            ]),
        );

        expect(index.get('/repo-vendor/bar/app.ts')).toEqual({ kind: 'modified', letter: 'M' });
        expect(index.has('/repo-vendor/bar')).toBe(false);
        expect(index.has('/repo-vendor')).toBe(false);
    });

    it('still drops a gitlink letter at a child root when the summary names no primary one', () => {
        const index = buildGitDecorationIndex(
            nestedSummary([
                { files: [gitlink('foo')], kind: 'nested', rootPath: '/repo' },
                { files: [], kind: 'nested', rootPath: '/repo/foo' },
            ]),
        );

        expect(index.get('/repo/foo')).toEqual({ kind: 'modified' });
    });

    it('bounds each repository by its own root when the summary names no primary one', () => {
        const index = buildGitDecorationIndex(
            nestedSummary([
                { files: [file({ path: 'src/app.ts' })], kind: 'nested', rootPath: '/repo/foo' },
            ]),
        );

        expect(index.get('/repo/foo/src')).toEqual({ kind: 'modified' });
        expect(index.has('/repo/foo')).toBe(false);
        expect(index.has('/repo')).toBe(false);
    });

    it('replaces the entry of a file whose status changed', () => {
        const previous = buildGitDecorationIndex(summary([file({ path: 'src/app.ts' })]));
        const next = buildGitDecorationIndex(
            summary([file({ path: 'src/app.ts', kind: 'deleted', workingTree: 'D' })]),
            previous,
        );

        expect(next.get('/repo/src/app.ts')).toEqual({ kind: 'deleted', letter: 'D' });
        expect(next.get('/repo/src/app.ts')).not.toBe(previous.get('/repo/src/app.ts'));
    });
});

describe('buildGitChildRepoIndex', () => {
    function repositories(
        kinds: ReadonlyArray<GitSummary['repositories'][number]['kind']>,
    ): GitSummary['repositories'] {
        return kinds.map((kind, order) => ({
            ...summary([]).repositories[0],
            id: `repo-${order}`,
            kind,
            rootPath: `/repo/child-${order}`,
        }));
    }

    it('indexes submodules and nested clones, and nothing else', () => {
        const index = buildGitChildRepoIndex({
            isRepository: true,
            repositories: repositories(['primary', 'submodule', 'nested', 'worktree']),
        });

        expect([...index]).toEqual([
            ['/repo/child-1', 'submodule'],
            ['/repo/child-2', 'nested'],
        ]);
    });

    it('returns the same index when the set of child repositories has not moved', () => {
        const previous = buildGitChildRepoIndex({
            isRepository: true,
            repositories: repositories(['primary', 'submodule']),
        });
        const next = buildGitChildRepoIndex(
            { isRepository: true, repositories: repositories(['primary', 'submodule']) },
            previous,
        );

        expect(next).toBe(previous);
    });

    it('replaces the index when a directory changes from nested clone to submodule', () => {
        const previous = buildGitChildRepoIndex({
            isRepository: true,
            repositories: repositories(['primary', 'nested']),
        });
        const next = buildGitChildRepoIndex(
            { isRepository: true, repositories: repositories(['primary', 'submodule']) },
            previous,
        );

        expect(next).not.toBe(previous);
        expect(next.get('/repo/child-1')).toBe('submodule');
    });

    it('empties out for a Project that is not a repository', () => {
        const previous = buildGitChildRepoIndex({
            isRepository: true,
            repositories: repositories(['submodule']),
        });

        expect(buildGitChildRepoIndex(undefined, previous).size).toBe(0);
        expect(
            buildGitChildRepoIndex({ isRepository: false, repositories: [] }, previous).size,
        ).toBe(0);
    });
});

describe('gitChildRepoDescription', () => {
    it('names each kind the way the row tooltip does', () => {
        expect(gitChildRepoDescription('submodule')).toBe('Git submodule.');
        expect(gitChildRepoDescription('nested')).toBe('Nested Git repository.');
    });
});

describe('gitDecorationClassName', () => {
    it('maps every change kind onto its own theme token', () => {
        expect(gitDecorationClassName('added')).toBe('text-git-added');
        expect(gitDecorationClassName('conflicted')).toBe('text-git-conflicting');
        expect(gitDecorationClassName('deleted')).toBe('text-git-deleted');
        expect(gitDecorationClassName('modified')).toBe('text-git-modified');
        expect(gitDecorationClassName('untracked')).toBe('text-git-untracked');
    });

    it('paints a rename in the untracked color, as VS Code does by default', () => {
        expect(gitDecorationClassName('renamed')).toBe(gitDecorationClassName('untracked'));
    });
});
