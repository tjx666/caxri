import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

const sourceControlRoot = join(
    process.cwd(),
    'src/renderer/src/features/view-containers/source-control',
);

describe('generic controlled Renderer surfaces', () => {
    it('keeps Git product semantics and command orchestration out of source-control', async () => {
        const productionFiles = (await readdir(sourceControlRoot))
            .filter((name) => /\.(?:ts|tsx)$/.test(name))
            .toSorted((left, right) => left.localeCompare(right));
        expect(productionFiles.filter((name) => name.startsWith('git-'))).toEqual([]);
        expect(productionFiles.filter((name) => name.includes('repository'))).toEqual([]);
        const sources = await Promise.all(
            productionFiles.map(async (name) => ({
                name,
                source: await readFile(join(sourceControlRoot, name), 'utf8'),
            })),
        );
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

        const operationClient = await readFile(
            join(sourceControlRoot, '..', 'view-operation-client.ts'),
            'utf8',
        );
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
