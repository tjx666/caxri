import type { GitSummary } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { resolveTerminalCommitLink } from '../reference-links';

const sharedSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const summary: GitSummary = {
    isRepository: true,
    repositories: [
        {
            additions: 0,
            ahead: 0,
            behind: 0,
            branch: 'main',
            changedFileCount: 0,
            deletions: 0,
            files: [],
            generation: 0,
            head: sharedSha,
            id: 'primary-repo',
            kind: 'primary',
            name: 'project',
            rootPath: '/project',
            truncated: false,
        },
        {
            additions: 0,
            ahead: 0,
            behind: 0,
            branch: 'main',
            changedFileCount: 0,
            deletions: 0,
            files: [],
            generation: 0,
            head: sharedSha,
            id: 'nested-repo',
            kind: 'nested',
            name: 'nested',
            rootPath: '/project/packages/nested',
            truncated: false,
        },
    ],
};

describe('resolveTerminalCommitLink', () => {
    it('resolves a commit found in one repository when another has no matching ref', async () => {
        const runGit = vi.fn((rootPath: string) =>
            Promise.resolve(rootPath === '/project' ? `${sharedSha}\n` : ''),
        );

        await expect(
            resolveTerminalCommitLink(summary, sharedSha.slice(0, 8), '/project', runGit),
        ).resolves.toEqual({
            status: 'resolved',
            candidate: {
                repositoryId: 'primary-repo',
                repositoryName: 'project',
                sha: sharedSha,
            },
        });
    });

    it('prefers the repository containing the Terminal cwd when worktrees share a commit', async () => {
        const runGit = vi.fn(() => Promise.resolve(`${sharedSha}\n`));

        await expect(
            resolveTerminalCommitLink(
                summary,
                sharedSha.slice(0, 8),
                '/project/packages/nested/src',
                runGit,
            ),
        ).resolves.toEqual({
            status: 'resolved',
            candidate: {
                repositoryId: 'nested-repo',
                repositoryName: 'nested',
                sha: sharedSha,
            },
        });
    });

    it('returns repository choices when the same short hash resolves to different commits', async () => {
        const runGit = vi.fn((rootPath: string) =>
            Promise.resolve(`${rootPath === '/project' ? sharedSha : otherSha}\n`),
        );

        await expect(
            resolveTerminalCommitLink(summary, 'abcdef0', '/project', runGit),
        ).resolves.toEqual({
            status: 'ambiguous',
            candidates: [
                {
                    repositoryId: 'primary-repo',
                    repositoryName: 'project',
                    sha: sharedSha,
                },
                {
                    repositoryId: 'nested-repo',
                    repositoryName: 'nested',
                    sha: otherSha,
                },
            ],
        });
    });
});
