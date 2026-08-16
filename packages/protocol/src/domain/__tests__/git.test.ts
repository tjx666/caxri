import { describe, expect, it } from 'vitest';

import {
    gitBlameSchema,
    gitBranchSchema,
    gitOverviewSchema,
    gitPullRequestChangesSchema,
    gitSummarySchema,
    MAX_GIT_STATUS_FILES,
} from '../git.js';

const sha = 'a'.repeat(40);

function fileStatus(path: string): Record<string, unknown> {
    return { path, index: 'M', workingTree: ' ', kind: 'modified' };
}

function repoSummary(files: Array<Record<string, unknown>> = []) {
    return {
        id: 'repository-1',
        kind: 'primary' as const,
        name: 'caxri',
        rootPath: '/private/project',
        branch: 'main',
        ahead: 0,
        behind: 0,
        additions: 0,
        deletions: 0,
        generation: 1,
        changedFileCount: files.length,
        truncated: false,
        files,
    };
}

describe('gitFileStatusSchema kind enum (via gitRepoSummarySchema)', () => {
    it('accepts every documented file status kind', () => {
        for (const kind of [
            'modified',
            'added',
            'deleted',
            'renamed',
            'untracked',
            'conflicted',
        ] as const) {
            expect(
                gitSummarySchema.safeParse({
                    isRepository: true,
                    repositories: [
                        repoSummary([{ path: 'a.ts', index: 'M', workingTree: ' ', kind }]),
                    ],
                }).success,
            ).toBe(true);
        }
    });

    it('rejects an unregistered file status kind', () => {
        expect(
            gitSummarySchema.safeParse({
                isRepository: true,
                repositories: [
                    repoSummary([{ path: 'a.ts', index: 'M', workingTree: ' ', kind: 'unmerged' }]),
                ],
            }).success,
        ).toBe(false);
    });
});

describe('gitRepoSummarySchema and gitSummarySchema', () => {
    it('accepts a well-formed repository summary with files', () => {
        const result = gitSummarySchema.safeParse({
            isRepository: true,
            repositories: [repoSummary([fileStatus('a.ts')])],
        });
        expect(result.success).toBe(true);
    });

    it('accepts a summary with no repositories and an error message', () => {
        expect(
            gitSummarySchema.safeParse({
                isRepository: false,
                repositories: [],
                error: 'not a repository',
            }).success,
        ).toBe(true);
    });

    it('rejects a repository kind outside the documented enum', () => {
        expect(
            gitSummarySchema.safeParse({
                isRepository: true,
                repositories: [{ ...repoSummary(), kind: 'bare' }],
            }).success,
        ).toBe(false);
    });

    it('rejects negative additions/deletions/generation/changedFileCount', () => {
        for (const field of ['additions', 'deletions', 'generation', 'changedFileCount'] as const) {
            expect(
                gitSummarySchema.safeParse({
                    isRepository: true,
                    repositories: [{ ...repoSummary(), [field]: -1 }],
                }).success,
            ).toBe(false);
        }
    });
});

describe('MAX_GIT_STATUS_FILES truncation contract', () => {
    it('accepts exactly the maximum number of status files', () => {
        const files = Array.from({ length: MAX_GIT_STATUS_FILES }, (_, index) =>
            fileStatus(`file-${index}.ts`),
        );
        expect(
            gitSummarySchema.safeParse({
                isRepository: true,
                repositories: [repoSummary(files)],
            }).success,
        ).toBe(true);
    });

    it('rejects one file over the maximum', () => {
        const files = Array.from({ length: MAX_GIT_STATUS_FILES + 1 }, (_, index) =>
            fileStatus(`file-${index}.ts`),
        );
        expect(
            gitSummarySchema.safeParse({
                isRepository: true,
                repositories: [repoSummary(files)],
            }).success,
        ).toBe(false);
    });
});

describe('gitOverviewSchema strips the files[] payload via gitRepoOverviewSchema', () => {
    it('parses successfully even when a repository entry carries a files array', () => {
        const result = gitOverviewSchema.safeParse({
            isRepository: true,
            repositories: [repoSummary([fileStatus('a.ts'), fileStatus('b.ts')])],
        });
        expect(result.success).toBe(true);
    });

    it('strips the files[] key from the parsed repository overview', () => {
        const result = gitOverviewSchema.parse({
            isRepository: true,
            repositories: [repoSummary([fileStatus('a.ts')])],
        });
        expect(result.repositories[0]).not.toHaveProperty('files');
        expect(result.repositories[0]).toMatchObject({ id: 'repository-1', branch: 'main' });
    });

    it('still enforces the non-file bounds on the overview projection', () => {
        expect(
            gitOverviewSchema.safeParse({
                isRepository: true,
                repositories: [{ ...repoSummary(), kind: 'bare' }],
            }).success,
        ).toBe(false);
    });
});

describe('gitBranchSchema', () => {
    it('accepts a well-formed branch name and committed timestamp', () => {
        expect(gitBranchSchema.safeParse({ name: 'main', committedAt: 0 }).success).toBe(true);
    });

    it('rejects an empty branch name', () => {
        expect(gitBranchSchema.safeParse({ name: '', committedAt: 0 }).success).toBe(false);
    });

    it('rejects a branch name over the maximum length', () => {
        expect(gitBranchSchema.safeParse({ name: 'a'.repeat(1_025), committedAt: 0 }).success).toBe(
            false,
        );
    });

    it('rejects a negative committedAt', () => {
        expect(gitBranchSchema.safeParse({ name: 'main', committedAt: -1 }).success).toBe(false);
    });
});

describe('gitBlameSchema', () => {
    const base = {
        sha,
        author: 'Author',
        authoredAt: 0,
        subject: 'Add feature',
        line: 1,
        uncommitted: false,
    };

    it('accepts a well-formed blame line', () => {
        expect(gitBlameSchema.safeParse(base).success).toBe(true);
    });

    it('rejects an empty author', () => {
        expect(gitBlameSchema.safeParse({ ...base, author: '' }).success).toBe(false);
    });

    it('rejects a non-positive line number', () => {
        expect(gitBlameSchema.safeParse({ ...base, line: 0 }).success).toBe(false);
        expect(gitBlameSchema.safeParse({ ...base, line: -1 }).success).toBe(false);
    });

    it('rejects a negative authoredAt', () => {
        expect(gitBlameSchema.safeParse({ ...base, authoredAt: -1 }).success).toBe(false);
    });
});

describe('gitPullRequestChangesSchema url and ref bounds', () => {
    const base = {
        repositoryId: 'repository-1',
        number: 1,
        title: 'Title',
        baseRefName: 'main',
        headRefName: 'feature',
        baseOid: sha,
        headOid: sha,
        additions: 1,
        deletions: 0,
        files: [],
    };

    it('accepts a well-formed https Pull Request url', () => {
        expect(
            gitPullRequestChangesSchema.safeParse({
                ...base,
                url: 'https://github.com/example/repo/pull/1',
            }).success,
        ).toBe(true);
    });

    it('rejects a non-url string', () => {
        expect(gitPullRequestChangesSchema.safeParse({ ...base, url: 'not-a-url' }).success).toBe(
            false,
        );
    });

    it('rejects an empty ref name', () => {
        expect(
            gitPullRequestChangesSchema.safeParse({
                ...base,
                url: 'https://github.com/example/repo/pull/1',
                baseRefName: '',
            }).success,
        ).toBe(false);
    });

    it('rejects a ref name over the maximum length', () => {
        expect(
            gitPullRequestChangesSchema.safeParse({
                ...base,
                url: 'https://github.com/example/repo/pull/1',
                headRefName: 'a'.repeat(1_025),
            }).success,
        ).toBe(false);
    });

    it('rejects a non-positive Pull Request number', () => {
        expect(
            gitPullRequestChangesSchema.safeParse({
                ...base,
                url: 'https://github.com/example/repo/pull/1',
                number: 0,
            }).success,
        ).toBe(false);
    });
});
