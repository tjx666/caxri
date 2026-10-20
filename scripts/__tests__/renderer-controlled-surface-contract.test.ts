import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import operationClient from '../../apps/desktop/src/renderer/src/features/view-containers/view-operation-client.ts?raw';

/**
 * Imported rather than read from disk so the changed-file check and Vitest's watch mode both see these files as this
 * test's dependencies. Only the directory's own files match, the same set a non-recursive `readdir` listed.
 */
const sourceControlFiles = import.meta.glob<string>(
    '../../apps/desktop/src/renderer/src/features/view-containers/source-control/*.{ts,tsx}',
    { eager: true, import: 'default', query: '?raw' },
);

describe('generic controlled Renderer surfaces', () => {
    it('keeps Git product semantics and command orchestration out of source-control', () => {
        const sources = Object.entries(sourceControlFiles)
            .map(([path, source]) => ({ name: posix.basename(path), source }))
            .toSorted((left, right) => left.name.localeCompare(right.name));
        const productionFiles = sources.map(({ name }) => name);
        expect(productionFiles.length).toBeGreaterThan(0);
        expect(productionFiles.filter((name) => name.startsWith('git-'))).toEqual([]);
        expect(productionFiles.filter((name) => name.includes('repository'))).toEqual([]);
        const forbidden = [
            'caxri.git',
            'Working Tree Changes',
            'Last Commit Changes',
            'Pull Request Changes',
            'Refresh Git',
            'git.summary',
            'git.sync',
            'git.discard',
            'git.pullRequestChanges',
            'git.commits',
            'git.commitDetails',
            'git.remoteHost',
            'GitSummary',
            'GitRepositorySummary',
            'GitPullRequestChanges',
            'GitCommitDetails',
            'WorkspaceGit',
            'parseGitDiffTab',
        ];

        for (const { name, source } of sources) {
            for (const productSemantic of forbidden) {
                expect(source, `${name} contains ${productSemantic}`).not.toContain(
                    productSemantic,
                );
            }
            for (const repoContract of [
                /\bSourceControlRepository\b/,
                /\bRepositoryModel\b/,
                /\.repositories\b/,
                /\bexpandedRepositories\b/,
            ])
                expect(source, `${name} contains ${repoContract}`).not.toMatch(repoContract);
        }

        const providerSection = sources.find(
            ({ name }) => name === 'source-control-provider-section.tsx',
        )?.source;
        const treeItems = sources.find(
            ({ name }) => name === 'source-control-tree-items.tsx',
        )?.source;
        expect(providerSection).not.toContain('actions.at(0)');
        expect(treeItems).not.toContain('actions?.[0]');

        for (const operation of [
            'git.summary',
            'git.sync',
            'git.discard',
            'git.pullRequestChanges',
            'git.commits',
            'git.commitDetails',
            'git.remoteHost',
        ])
            expect(operationClient, `view-operation-client.ts contains ${operation}`).not.toContain(
                operation,
            );
    });
});
