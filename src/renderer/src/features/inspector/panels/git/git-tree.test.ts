import type { GitFileStatus, GitRepositorySummary } from '@shared/types';
import { describe, expect, it } from 'vitest';

import { buildGitFileTree, submoduleRepositoriesByPath } from './git-tree';

function modified(path: string): GitFileStatus {
    return { index: ' ', kind: 'modified', path, workingTree: 'M' };
}

function repo(
    id: string,
    kind: GitRepositorySummary['kind'],
    rootPath: string,
): GitRepositorySummary {
    return {
        id,
        kind,
        name: id,
        rootPath,
        branch: 'main',
        ahead: 0,
        behind: 0,
        additions: 0,
        deletions: 0,
        generation: 0,
        changedFileCount: 0,
        truncated: false,
        files: [],
    };
}

describe('submoduleRepositoriesByPath', () => {
    it('maps a parent-relative mount path to its submodule repository summary', () => {
        const parent = repo('parent', 'primary', '/work/app');
        const submodule = repo('sub', 'submodule', '/work/app/vendor/lobehub');
        const map = submoduleRepositoriesByPath(parent, [
            parent,
            submodule,
            repo('nested', 'nested', '/work/app/nested'),
            repo('outside', 'submodule', '/elsewhere/lobehub'),
        ]);
        expect(map.entries().toArray()).toEqual([['vendor/lobehub', submodule]]);
    });

    it('never maps a submodule repository onto itself', () => {
        const submodule = repo('sub', 'submodule', '/work/app/lobehub');
        expect(submoduleRepositoriesByPath(submodule, [submodule]).size).toBe(0);
    });
});

describe('buildGitFileTree', () => {
    it('groups changed files by directory while preserving their full Git paths', () => {
        expect(
            buildGitFileTree([
                modified('src/runtime/git/index.ts'),
                modified('README.md'),
                modified('src/renderer/App.tsx'),
            ]),
        ).toEqual([
            {
                children: [
                    {
                        children: [
                            {
                                file: modified('src/renderer/App.tsx'),
                                kind: 'file',
                                name: 'App.tsx',
                                path: 'src/renderer/App.tsx',
                            },
                        ],
                        kind: 'directory',
                        name: 'renderer',
                        path: 'src/renderer',
                    },
                    {
                        children: [
                            {
                                children: [
                                    {
                                        file: modified('src/runtime/git/index.ts'),
                                        kind: 'file',
                                        name: 'index.ts',
                                        path: 'src/runtime/git/index.ts',
                                    },
                                ],
                                kind: 'directory',
                                name: 'git',
                                path: 'src/runtime/git',
                            },
                        ],
                        kind: 'directory',
                        name: 'runtime',
                        path: 'src/runtime',
                    },
                ],
                kind: 'directory',
                name: 'src',
                path: 'src',
            },
            {
                file: modified('README.md'),
                kind: 'file',
                name: 'README.md',
                path: 'README.md',
            },
        ]);
    });
});
