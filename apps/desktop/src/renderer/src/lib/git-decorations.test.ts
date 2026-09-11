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

describe('buildGitDecorationIndex', () => {
    it('decorates a changed file with its kind and status letter', () => {
        const index = buildGitDecorationIndex(summary([file({ path: 'src/app.ts' })]));

        expect(index.get('/repo/src/app.ts')).toEqual({ kind: 'modified', letter: 'M' });
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
