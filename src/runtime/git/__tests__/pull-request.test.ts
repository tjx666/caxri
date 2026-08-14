import { describe, expect, it, vi } from 'vitest';

import type { GitRepositorySummary } from '../../../shared/types';
import { GitPullRequestService } from '../pull-request';

const BASE_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);

function repository(sessionId: string, repositoryId: string): GitRepositorySummary {
    return {
        additions: 0,
        ahead: 0,
        behind: 0,
        branch: 'feature/cache',
        deletions: 0,
        files: [],
        head: HEAD_OID,
        id: repositoryId,
        kind: 'primary',
        name: repositoryId,
        rootPath: `/repository/${sessionId}/${repositoryId}`,
    };
}

function pullRequestView(number: number) {
    return JSON.stringify({
        baseRefName: 'main',
        baseRefOid: BASE_OID,
        headRefName: 'feature/cache',
        headRefOid: HEAD_OID,
        number,
        title: `Pull request ${number}`,
        url: `https://github.com/tjx666/caxri/pull/${number}`,
    });
}

function createService(options: { capacity?: number; now?: () => number } = {}) {
    let sequence = 0;
    const ghPullRequestView = vi.fn(() => Promise.resolve(pullRequestView(++sequence)));
    const service = new GitPullRequestService(
        {
            git: vi.fn(() => Promise.resolve('')),
            ghPullRequestView,
            resolveRepository: (sessionId, repositoryId) =>
                Promise.resolve(repository(sessionId, repositoryId)),
        },
        {
            maximumCacheEntries: options.capacity,
            now: options.now,
        },
    );
    return { ghPullRequestView, service };
}

function changes(service: GitPullRequestService, sessionId: string, repositoryId = 'repository') {
    return service.changes({ refresh: 0, repositoryId, sessionId });
}

describe('GitPullRequestService', () => {
    it('reuses the same current repository state for 30 seconds', async () => {
        let now = 0;
        const { ghPullRequestView, service } = createService({ now: () => now });

        await changes(service, 'session-a');
        now = 29_999;
        await changes(service, 'session-a');
        now = 30_000;
        await changes(service, 'session-a');

        expect(ghPullRequestView).toHaveBeenCalledTimes(2);
    });

    it('prunes expired entries before adding a new cache value', async () => {
        let now = 0;
        const { service } = createService({ capacity: 2, now: () => now });

        await changes(service, 'session-a');
        now = 30_001;
        await changes(service, 'session-b');

        expect((service as unknown as { cache: Map<string, unknown> }).cache.size).toBe(1);
    });

    it('evicts the least recently used entry at the fixed capacity', async () => {
        const { ghPullRequestView, service } = createService({ capacity: 2 });

        await changes(service, 'session-a');
        await changes(service, 'session-b');
        await changes(service, 'session-a');
        await changes(service, 'session-c');
        await changes(service, 'session-b');

        expect(ghPullRequestView).toHaveBeenCalledTimes(4);
    });

    it('keeps legal identifier tuples isolated when their colon-joined forms would collide', async () => {
        const { ghPullRequestView, service } = createService();

        const first = await changes(service, 'session:a', 'repository');
        const second = await changes(service, 'session', 'a:repository');
        const firstAgain = await changes(service, 'session:a', 'repository');

        expect([first?.number, second?.number, firstAgain?.number]).toEqual([1, 2, 1]);
        expect(ghPullRequestView).toHaveBeenCalledTimes(2);
    });

    it('evicts only requested Sessions and refetches them on demand', async () => {
        const { ghPullRequestView, service } = createService();

        await changes(service, 'session-a');
        await changes(service, 'session-b');
        service.evictSessions(['session-a']);
        await changes(service, 'session-b');
        await changes(service, 'session-a');

        expect(ghPullRequestView).toHaveBeenCalledTimes(3);
    });

    it('clears every retained Pull Request file list during service shutdown', async () => {
        const { ghPullRequestView, service } = createService();

        await changes(service, 'session-a');
        await changes(service, 'session-b');
        service.clear();
        await changes(service, 'session-a');
        await changes(service, 'session-b');

        expect(ghPullRequestView).toHaveBeenCalledTimes(4);
    });

    it('coalesces concurrent requests for the same current repository state', async () => {
        let resolveView: ((value: string) => void) | undefined;
        const ghPullRequestView = vi.fn(
            () => new Promise<string>((resolve) => (resolveView = resolve)),
        );
        const service = new GitPullRequestService({
            git: vi.fn(() => Promise.resolve('')),
            ghPullRequestView,
            resolveRepository: (sessionId, repositoryId) =>
                Promise.resolve(repository(sessionId, repositoryId)),
        });

        const first = changes(service, 'session-a');
        const second = changes(service, 'session-a');
        await vi.waitFor(() => expect(ghPullRequestView).toHaveBeenCalledOnce());
        resolveView?.(pullRequestView(1));

        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ number: 1 }),
            expect.objectContaining({ number: 1 }),
        ]);
    });

    it('does not repopulate a deleted Session from an older in-flight request', async () => {
        let resolveView: ((value: string) => void) | undefined;
        const ghPullRequestView = vi
            .fn<() => Promise<string>>()
            .mockImplementationOnce(() => new Promise<string>((resolve) => (resolveView = resolve)))
            .mockResolvedValueOnce(pullRequestView(2));
        const service = new GitPullRequestService({
            git: vi.fn(() => Promise.resolve('')),
            ghPullRequestView,
            resolveRepository: (sessionId, repositoryId) =>
                Promise.resolve(repository(sessionId, repositoryId)),
        });

        const staleRequest = changes(service, 'session-a');
        await vi.waitFor(() => expect(ghPullRequestView).toHaveBeenCalledOnce());
        service.evictSessions(['session-a']);
        resolveView?.(pullRequestView(1));
        await staleRequest;
        await changes(service, 'session-a');

        expect(ghPullRequestView).toHaveBeenCalledTimes(2);
    });

    it('invalidates a request deleted while repository resolution is still pending', async () => {
        let resolveRepository: ((value: GitRepositorySummary) => void) | undefined;
        const ghPullRequestView = vi.fn(() => Promise.resolve(pullRequestView(1)));
        const repositoryLookup = vi
            .fn<(sessionId: string, repositoryId: string) => Promise<GitRepositorySummary>>()
            .mockImplementationOnce(
                () => new Promise<GitRepositorySummary>((resolve) => (resolveRepository = resolve)),
            )
            .mockImplementation((sessionId, repositoryId) =>
                Promise.resolve(repository(sessionId, repositoryId)),
            );
        const service = new GitPullRequestService({
            git: vi.fn(() => Promise.resolve('')),
            ghPullRequestView,
            resolveRepository: repositoryLookup,
        });

        const staleRequest = changes(service, 'session-a');
        await vi.waitFor(() => expect(repositoryLookup).toHaveBeenCalledOnce());
        service.evictSessions(['session-a']);
        resolveRepository?.(repository('session-a', 'repository'));
        await staleRequest;
        await changes(service, 'session-a');

        expect(ghPullRequestView).toHaveBeenCalledTimes(2);
    });
});
