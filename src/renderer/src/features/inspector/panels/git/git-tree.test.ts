import type { GitFileStatus } from '@shared/types';
import { describe, expect, it } from 'vitest';

import { buildGitFileTree } from './git-tree';

function modified(path: string): GitFileStatus {
    return { index: ' ', kind: 'modified', path, workingTree: 'M' };
}

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
