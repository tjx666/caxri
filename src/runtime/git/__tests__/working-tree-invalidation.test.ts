import { describe, expect, it, vi } from 'vitest';

import type { GitRepositorySummary as GitRepoSummary } from '../../../shared/types';
import type { GitDiscardSnapshot } from '../repo';
import { GitWorkingTreeService } from '../working-tree';

const repo: GitRepoSummary = {
    id: 'repo-1',
    kind: 'primary',
    name: 'project',
    rootPath: '/authorized/project',
    branch: 'main',
    head: '0123456789abcdef0123456789abcdef01234567',
    ahead: 1,
    behind: 0,
    additions: 1,
    deletions: 0,
    generation: 1,
    changedFileCount: 1,
    truncated: false,
    files: [
        {
            path: 'tracked.txt',
            index: ' ',
            workingTree: 'M',
            kind: 'modified',
        },
    ],
};

const snapshot: GitDiscardSnapshot = {
    authorizedPaths: ['tracked.txt'],
    files: repo.files,
    fingerprint: 'fingerprint-1',
    repository: repo,
};

describe('GitWorkingTreeService invalidation', () => {
    it('reports successful Sync and Discard mutations without waiting for a watcher echo', async () => {
        const onDidMutate = vi.fn();
        const service = new GitWorkingTreeService({
            git: vi.fn(() => Promise.resolve('')),
            onDidMutate,
            resolveRepository: () => Promise.resolve(repo),
            snapshot: () => Promise.resolve(snapshot),
        });

        await service.sync({ sessionId: 'session-1', repositoryId: repo.id });
        const preflight = await service.discardPreflight({
            sessionId: 'session-1',
            repositoryId: repo.id,
            scope: { kind: 'file', path: 'tracked.txt' },
        });
        expect(preflight.status).toBe('ready');
        if (preflight.status !== 'ready') throw new Error('Expected discard consent');
        await service.discardApply({ token: preflight.token });

        expect(onDidMutate).toHaveBeenNthCalledWith(1, repo.rootPath);
        expect(onDidMutate).toHaveBeenNthCalledWith(2, repo.rootPath);
    });

    it('does not publish invalidation when a mutation fails', async () => {
        const onDidMutate = vi.fn();
        const service = new GitWorkingTreeService({
            git: vi.fn(() => Promise.reject(new Error('Git failed'))),
            onDidMutate,
            resolveRepository: () => Promise.resolve(repo),
            snapshot: () => Promise.resolve(snapshot),
        });

        await expect(
            service.sync({ sessionId: 'session-1', repositoryId: repo.id }),
        ).rejects.toThrow('Git failed');
        expect(onDidMutate).not.toHaveBeenCalled();
    });
});
