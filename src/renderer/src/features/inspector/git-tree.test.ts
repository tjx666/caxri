import { describe, expect, it } from 'vitest';

import type { GitFileStatus } from '@shared/types';

import { buildGitFileTree } from './git-tree';

function modified(path: string): GitFileStatus {
    return { index: ' ', kind: 'modified', path, workingTree: 'M' };
}

describe('buildGitFileTree', () => {
    it('groups changed files by directory while preserving their full Git paths', () => {
        expect(
            buildGitFileTree([
                modified('src/runtime/git.ts'),
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
                                file: modified('src/runtime/git.ts'),
                                kind: 'file',
                                name: 'git.ts',
                                path: 'src/runtime/git.ts',
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
