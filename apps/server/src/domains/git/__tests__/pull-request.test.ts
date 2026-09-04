import type { GitRepositorySummary as GitRepoSummary } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { GitPullRequestService, parsePullRequestView } from '../pull-request';

const BASE_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);

function repo(sessionId: string, repoId: string): GitRepoSummary {
    return {
        additions: 0,
        ahead: 0,
        behind: 0,
        branch: 'feature/cache',
        changedFileCount: 0,
        deletions: 0,
        files: [],
        generation: 0,
        head: HEAD_OID,
        id: repoId,
        kind: 'primary',
        name: repoId,
        rootPath: `/repository/${sessionId}/${repoId}`,
        truncated: false,
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
    // Explicitly typed so `mock.calls` records the `isForced` flag the service threads through.
    const viewPullRequest = vi.fn<(repo: GitRepoSummary, isForced: boolean) => Promise<string>>(
        () => Promise.resolve(pullRequestView(++sequence)),
    );
    const service = new GitPullRequestService(
        {
            git: vi.fn(() => Promise.resolve('')),
            pullRequestView: viewPullRequest,
            resolveRepository: (sessionId, repoId) => Promise.resolve(repo(sessionId, repoId)),
        },
        {
            maximumCacheEntries: options.capacity,
            now: options.now,
        },
    );
    return { viewPullRequest, service };
}

function changes(service: GitPullRequestService, sessionId: string, repoId = 'repository') {
    return service.changes({ refresh: 0, repositoryId: repoId, sessionId });
}

describe('parsePullRequestView', () => {
    it('rejects malformed GitHub CLI JSON as GIT instead of asserting a view', () => {
        expect(() => parsePullRequestView('{')).toThrow(
            expect.objectContaining({ code: 'GIT' }) as Error,
        );
        expect(() =>
            parsePullRequestView(
                JSON.stringify({
                    number: '1',
                    title: 'PR',
                    url: 'https://github.com/tjx666/caxri/pull/1',
                    baseRefName: 'main',
                    headRefName: 'feature',
                    baseRefOid: BASE_OID,
                    headRefOid: HEAD_OID,
                }),
            ),
        ).toThrow(expect.objectContaining({ code: 'GIT' }) as Error);
    });
});

describe('GitPullRequestService', () => {
    it('misses cache when the resolved repository branch or head changes', async () => {
        let current = repo('session-a', 'repository');
        const viewPullRequest = vi.fn(() => Promise.resolve(pullRequestView(1)));
        const service = new GitPullRequestService({
            git: vi.fn(() => Promise.resolve('')),
            pullRequestView: viewPullRequest,
            resolveRepository: () => Promise.resolve(current),
        });

        await changes(service, 'session-a');
        current = { ...current, branch: 'feature/next', head: 'c'.repeat(40) };
        viewPullRequest.mockResolvedValueOnce(pullRequestView(2));
        const next = await changes(service, 'session-a');

        expect(next).toMatchObject({ number: 2 });
        expect(viewPullRequest).toHaveBeenCalledTimes(2);
    });

    it('reuses the same current repository state for 30 seconds', async () => {
        let now = 0;
        const { viewPullRequest, service } = createService({ now: () => now });

        await changes(service, 'session-a');
        now = 29_999;
        await changes(service, 'session-a');
        now = 30_000;
        await changes(service, 'session-a');

        expect(viewPullRequest).toHaveBeenCalledTimes(2);
    });

    it('forces the shared record to refetch when the user asks Source Control to refresh', async () => {
        const { viewPullRequest, service } = createService();

        await changes(service, 'session-a');
        // A force-push changes the head OID this diff is computed from, so skipping only the local file-list cache
        // would still serve a stale range out of the Server-wide GitHub record.
        await service.changes({ refresh: 1, repositoryId: 'repository', sessionId: 'session-a' });

        expect(viewPullRequest.mock.calls.map((call) => call[1])).toEqual([false, true]);
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
        const { viewPullRequest, service } = createService({ capacity: 2 });

        await changes(service, 'session-a');
        await changes(service, 'session-b');
        await changes(service, 'session-a');
        await changes(service, 'session-c');
        await changes(service, 'session-b');

        expect(viewPullRequest).toHaveBeenCalledTimes(4);
    });

    it('keeps legal identifier tuples isolated when their colon-joined forms would collide', async () => {
        const { viewPullRequest, service } = createService();

        const first = await changes(service, 'session:a', 'repository');
        const second = await changes(service, 'session', 'a:repository');
        const firstAgain = await changes(service, 'session:a', 'repository');

        expect([first?.number, second?.number, firstAgain?.number]).toEqual([1, 2, 1]);
        expect(viewPullRequest).toHaveBeenCalledTimes(2);
    });

    it('evicts only requested Sessions and refetches them on demand', async () => {
        const { viewPullRequest, service } = createService();

        await changes(service, 'session-a');
        await changes(service, 'session-b');
        service.evictSessions(['session-a']);
        await changes(service, 'session-b');
        await changes(service, 'session-a');

        expect(viewPullRequest).toHaveBeenCalledTimes(3);
    });

    it('clears every retained Pull Request file list during service shutdown', async () => {
        const { viewPullRequest, service } = createService();

        await changes(service, 'session-a');
        await changes(service, 'session-b');
        service.clear();
        await changes(service, 'session-a');
        await changes(service, 'session-b');

        expect(viewPullRequest).toHaveBeenCalledTimes(4);
    });

    it('coalesces concurrent requests for the same current repository state', async () => {
        let resolveView: ((value: string) => void) | undefined;
        const viewPullRequest = vi.fn(
            () => new Promise<string>((resolve) => (resolveView = resolve)),
        );
        const service = new GitPullRequestService({
            git: vi.fn(() => Promise.resolve('')),
            pullRequestView: viewPullRequest,
            resolveRepository: (sessionId, repoId) => Promise.resolve(repo(sessionId, repoId)),
        });

        const first = changes(service, 'session-a');
        const second = changes(service, 'session-a');
        await vi.waitFor(() => expect(viewPullRequest).toHaveBeenCalledOnce());
        resolveView?.(pullRequestView(1));

        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ number: 1 }),
            expect.objectContaining({ number: 1 }),
        ]);
    });

    it('does not repopulate a deleted Session from an older in-flight request', async () => {
        let resolveView: ((value: string) => void) | undefined;
        const viewPullRequest = vi
            .fn<() => Promise<string>>()
            .mockImplementationOnce(() => new Promise<string>((resolve) => (resolveView = resolve)))
            .mockResolvedValueOnce(pullRequestView(2));
        const service = new GitPullRequestService({
            git: vi.fn(() => Promise.resolve('')),
            pullRequestView: viewPullRequest,
            resolveRepository: (sessionId, repoId) => Promise.resolve(repo(sessionId, repoId)),
        });

        const staleRequest = changes(service, 'session-a');
        await vi.waitFor(() => expect(viewPullRequest).toHaveBeenCalledOnce());
        service.evictSessions(['session-a']);
        resolveView?.(pullRequestView(1));
        await staleRequest;
        await changes(service, 'session-a');

        expect(viewPullRequest).toHaveBeenCalledTimes(2);
    });

    it('invalidates a request deleted while repository resolution is still pending', async () => {
        let resolveRepo: ((value: GitRepoSummary) => void) | undefined;
        const viewPullRequest = vi.fn(() => Promise.resolve(pullRequestView(1)));
        const repoLookup = vi
            .fn<(sessionId: string, repoId: string) => Promise<GitRepoSummary>>()
            .mockImplementationOnce(
                () => new Promise<GitRepoSummary>((resolve) => (resolveRepo = resolve)),
            )
            .mockImplementation((sessionId, repoId) => Promise.resolve(repo(sessionId, repoId)));
        const service = new GitPullRequestService({
            git: vi.fn(() => Promise.resolve('')),
            pullRequestView: viewPullRequest,
            resolveRepository: repoLookup,
        });

        const staleRequest = changes(service, 'session-a');
        await vi.waitFor(() => expect(repoLookup).toHaveBeenCalledOnce());
        service.evictSessions(['session-a']);
        resolveRepo?.(repo('session-a', 'repository'));
        await staleRequest;
        await changes(service, 'session-a');

        expect(viewPullRequest).toHaveBeenCalledTimes(2);
    });
});
