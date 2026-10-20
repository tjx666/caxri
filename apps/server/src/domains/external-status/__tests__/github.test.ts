import { describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../command';
import { ExternalStatusCliError } from '../command';
import { GitHubPullRequestStore } from '../github';

const OWNER = 'example';
const REPO = 'example';

function pullRequest(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        number: 19_024,
        title: 'feat: migrate search',
        url: 'https://github.com/example/example/pull/19024',
        state: 'OPEN',
        isDraft: false,
        body: 'Closes TASK-123',
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        baseRefName: 'main',
        headRefName: 'feat/search',
        baseRefOid: 'a'.repeat(40),
        headRefOid: 'b'.repeat(40),
        ...overrides,
    });
}

function createStore(
    runner: ReturnType<typeof vi.fn<ExternalStatusRunner>>,
    now: () => number = () => 0,
) {
    return new GitHubPullRequestStore(runner, { now });
}

describe('GitHubPullRequestStore', () => {
    it('serves a branch read and a number read for one pull request from a single query', async () => {
        const runner = vi.fn<ExternalStatusRunner>(() => Promise.resolve(pullRequest()));
        const store = createStore(runner);

        // The status bar asks by branch; the sidebar sweep asks by number after its own discovery.
        await store.view({ branch: 'feat/search', cwd: '/project', owner: OWNER, repo: REPO });
        await store.view({ cwd: '/project', number: 19_024, owner: OWNER, repo: REPO });

        expect(runner).toHaveBeenCalledOnce();
    });

    it('reuses one record for the branch a previous number read resolved to', async () => {
        const runner = vi.fn<ExternalStatusRunner>(() => Promise.resolve(pullRequest()));
        const store = createStore(runner);

        await store.view({ cwd: '/project', number: 19_024, owner: OWNER, repo: REPO });
        await store.view({ branch: 'feat/search', cwd: '/project', owner: OWNER, repo: REPO });

        expect(runner).toHaveBeenCalledOnce();
    });

    it('coalesces concurrent reads of the same reference', async () => {
        const pending = Promise.withResolvers<string>();
        const runner = vi.fn<ExternalStatusRunner>(() => pending.promise);
        const store = createStore(runner);

        const first = store.view({
            branch: 'feat/search',
            cwd: '/project',
            owner: OWNER,
            repo: REPO,
        });
        const second = store.view({
            branch: 'feat/search',
            cwd: '/project',
            owner: OWNER,
            repo: REPO,
        });
        pending.resolve(pullRequest());

        await expect(Promise.all([first, second])).resolves.toEqual([pullRequest(), pullRequest()]);
        expect(runner).toHaveBeenCalledOnce();
    });

    it('remembers that a branch has no pull request instead of re-asking every minute', async () => {
        const runner = vi.fn<ExternalStatusRunner>(() =>
            Promise.reject(
                new ExternalStatusCliError('gh', 'other', 'no pull requests found for branch main'),
            ),
        );
        let now = 0;
        const store = createStore(runner, () => now);

        await expect(
            store.view({ branch: 'main', cwd: '/project', owner: OWNER, repo: REPO }),
        ).resolves.toBeUndefined();
        now += 120_000;
        await expect(
            store.view({ branch: 'main', cwd: '/project', owner: OWNER, repo: REPO }),
        ).resolves.toBeUndefined();

        expect(runner).toHaveBeenCalledOnce();
    });

    it('never caches a quota failure as an absent pull request', async () => {
        const runner = vi.fn<ExternalStatusRunner>(() =>
            Promise.reject(new ExternalStatusCliError('gh', 'rate-limited', 'API rate limit')),
        );
        const store = createStore(runner);

        await expect(
            store.view({ branch: 'feat/search', cwd: '/project', owner: OWNER, repo: REPO }),
        ).rejects.toMatchObject({ kind: 'rate-limited' });

        runner.mockResolvedValueOnce(pullRequest());
        await expect(
            store.view({ branch: 'feat/search', cwd: '/project', owner: OWNER, repo: REPO }),
        ).resolves.toBe(pullRequest());
    });

    it('keeps serving the last known pull request while GitHub is rate limited', async () => {
        const runner = vi.fn<ExternalStatusRunner>(() => Promise.resolve(pullRequest()));
        let now = 0;
        const store = createStore(runner, () => now);
        const lookup = { branch: 'feat/search', cwd: '/project', owner: OWNER, repo: REPO };

        await expect(store.view(lookup)).resolves.toBe(pullRequest());

        // Every surface reading this record would otherwise swap a good pull request for an error for the whole pause.
        runner.mockRejectedValue(
            new ExternalStatusCliError('gh', 'rate-limited', 'API rate limit'),
        );
        now += 120_000;
        await expect(store.view(lookup)).resolves.toBe(pullRequest());

        // The record stays stale, so the first read after the circuit closes picks up the new state.
        runner.mockResolvedValue(pullRequest({ state: 'MERGED' }));
        await expect(store.view(lookup)).resolves.toBe(pullRequest({ state: 'MERGED' }));
    });

    it('lets an availability-sensitive reader see a failure while another reader keeps stale data', async () => {
        const pending = Promise.withResolvers<string>();
        const runner = vi.fn<ExternalStatusRunner>(() => Promise.resolve(pullRequest()));
        let now = 0;
        const store = createStore(runner, () => now);
        const lookup = { branch: 'feat/search', cwd: '/project', owner: OWNER, repo: REPO };
        await store.view(lookup);

        now += 120_000;
        runner.mockImplementation(() => pending.promise);
        const strict = store.view({ ...lookup, allowStaleOnFailure: false });
        const lenient = store.view(lookup);
        pending.reject(new ExternalStatusCliError('gh', 'not-logged-in', 'auth required'));

        await expect(strict).rejects.toMatchObject({ kind: 'not-logged-in' });
        await expect(lenient).resolves.toBe(pullRequest());
        expect(runner).toHaveBeenCalledTimes(2);
    });

    it('outlives the Renderer poll interval so a single surface still hits the record', async () => {
        const runner = vi.fn<ExternalStatusRunner>(() => Promise.resolve(pullRequest()));
        let now = 0;
        const store = createStore(runner, () => now);
        const lookup = { branch: 'feat/search', cwd: '/project', owner: OWNER, repo: REPO };

        await store.view(lookup);
        // `usePolledQuery` schedules the next request after the previous one settles, so a 60s poll always lands late.
        now += 60_000 + 250;
        await store.view(lookup);

        expect(runner).toHaveBeenCalledOnce();
    });

    it('refetches for an explicit user refresh but not for an automatic revalidation', async () => {
        const runner = vi.fn<ExternalStatusRunner>(() => Promise.resolve(pullRequest()));
        const store = createStore(runner);
        const lookup = { branch: 'feat/search', cwd: '/project', owner: OWNER, repo: REPO };

        await store.view(lookup);
        await store.view(lookup);
        expect(runner).toHaveBeenCalledOnce();

        await store.view({ ...lookup, maxAgeMs: 0 });
        expect(runner).toHaveBeenCalledTimes(2);
    });

    it('requests every field its consumers need in one query', async () => {
        const runner = vi.fn<ExternalStatusRunner>(() => Promise.resolve(pullRequest()));
        const store = createStore(runner);

        await store.view({ branch: 'feat/search', cwd: '/project', owner: OWNER, repo: REPO });

        expect(runner.mock.calls[0]?.[1]).toEqual([
            'pr',
            'view',
            'feat/search',
            '--repo',
            'example/example',
            '--json',
            'number,title,url,state,isDraft,body,statusCheckRollup,baseRefName,headRefName,baseRefOid,headRefOid,mergeCommit,mergedAt,mergeable,mergeStateStatus',
        ]);
    });
});
