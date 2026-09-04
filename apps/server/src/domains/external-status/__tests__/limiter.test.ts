import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalStatusCliError } from '../command';
import type { GitHubQuota } from '../limiter';
import { ExternalStatusLimiter, parseGitHubRateLimit } from '../limiter';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pending = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

async function pausePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-external-status-'));
    temporaryDirectories.push(directory);
    return join(directory, 'external-status-limit.json');
}

function rateLimited(source: 'gh' | 'linear' | 'vc', message = 'API rate limit exceeded') {
    return () => Promise.reject(new ExternalStatusCliError(source, 'rate-limited', message));
}

describe('ExternalStatusLimiter', () => {
    it('pauses GitHub until the reset it reports instead of retrying on the next poll', async () => {
        let now = 1_000_000;
        let quota: GitHubQuota = { remaining: 0, resetAt: 1_900_000 };
        const limiter = new ExternalStatusLimiter({
            now: () => now,
            pausePath: await pausePath(),
            probeQuota: () => Promise.resolve(quota),
        });

        await expect(limiter.guard('gh', rateLimited('gh'))).rejects.toMatchObject({
            kind: 'rate-limited',
        });

        const work = vi.fn(() => Promise.resolve('ok'));
        now += 60_000;
        await expect(limiter.guard('gh', work)).rejects.toMatchObject({ kind: 'rate-limited' });
        expect(work).not.toHaveBeenCalled();

        // GitHub replenishes the budget when its window rolls over.
        now = 1_960_000;
        quota = { remaining: 5_000, resetAt: now + 3_600_000 };
        await expect(limiter.guard('gh', work)).resolves.toBe('ok');
    });

    it('clears a secondary limit in a minute rather than waiting for the hourly reset', async () => {
        let now = 1_000_000;
        const limiter = new ExternalStatusLimiter({
            now: () => now,
            pausePath: await pausePath(),
            probeQuota: () => Promise.resolve({ remaining: 4_000, resetAt: now + 3_600_000 }),
        });

        await expect(
            limiter.guard('gh', rateLimited('gh', 'You have exceeded a secondary rate limit')),
        ).rejects.toMatchObject({ kind: 'rate-limited' });

        now += 61_000;
        await expect(limiter.guard('gh', () => Promise.resolve('ok'))).resolves.toBe('ok');
    });

    it('keeps a limited source from silencing the other two', async () => {
        const now = 1_000_000;
        const limiter = new ExternalStatusLimiter({
            now: () => now,
            pausePath: await pausePath(),
            probeQuota: () => Promise.resolve({ remaining: 5_000, resetAt: now + 3_600_000 }),
        });

        await expect(limiter.guard('gh', rateLimited('gh'))).rejects.toMatchObject({
            kind: 'rate-limited',
        });

        await expect(limiter.guard('linear', () => Promise.resolve('issue'))).resolves.toBe(
            'issue',
        );
        await expect(limiter.guard('vc', () => Promise.resolve('deployment'))).resolves.toBe(
            'deployment',
        );
    });

    it('backs off geometrically for a CLI that reports no reset, and recovers on success', async () => {
        let now = 1_000_000;
        const limiter = new ExternalStatusLimiter({
            now: () => now,
            pausePath: await pausePath(),
        });

        await expect(limiter.guard('vc', rateLimited('vc'))).rejects.toMatchObject({
            kind: 'rate-limited',
        });
        now += 61_000;
        await expect(limiter.guard('vc', rateLimited('vc'))).rejects.toMatchObject({
            kind: 'rate-limited',
        });

        // Second failure moves from the 60s step to the 120s step.
        now += 61_000;
        await expect(limiter.guard('vc', () => Promise.resolve('ok'))).rejects.toMatchObject({
            kind: 'rate-limited',
        });
        now += 61_000;
        await expect(limiter.guard('vc', () => Promise.resolve('ok'))).resolves.toBe('ok');

        // A success resets the ladder, so the next failure pauses for 60s again rather than 300s.
        await expect(limiter.guard('vc', rateLimited('vc'))).rejects.toMatchObject({
            kind: 'rate-limited',
        });
        now += 61_000;
        await expect(limiter.guard('vc', () => Promise.resolve('ok'))).resolves.toBe('ok');
    });

    it('shares one pause with a sibling Server through the cache file', async () => {
        const now = 1_000_000;
        const path = await pausePath();
        const options = {
            now: () => now,
            pausePath: path,
            probeQuota: () => Promise.resolve({ remaining: 0, resetAt: now + 600_000 }),
            reloadIntervalMs: 0,
        };
        const first = new ExternalStatusLimiter(options);
        const second = new ExternalStatusLimiter({ ...options, probeQuota: undefined });

        await expect(first.guard('gh', rateLimited('gh'))).rejects.toMatchObject({
            kind: 'rate-limited',
        });

        const work = vi.fn(() => Promise.resolve('ok'));
        await expect(second.guard('gh', work)).rejects.toMatchObject({ kind: 'rate-limited' });
        expect(work).not.toHaveBeenCalled();
    });

    it('keeps a sibling pause for another source when writing its own', async () => {
        const now = 1_000_000;
        const path = await pausePath();
        // A long reload interval is the real hazard: `sibling` records its GitHub pause inside `local`'s window, so
        // `local` writes `vc` without ever having read it. A blind overwrite would drop GitHub from the shared file.
        const local = new ExternalStatusLimiter({ now: () => now, pausePath: path });
        const sibling = new ExternalStatusLimiter({
            now: () => now,
            pausePath: path,
            probeQuota: () => Promise.resolve({ remaining: 0, resetAt: now + 600_000 }),
        });

        await expect(local.guard('vc', rateLimited('vc'))).rejects.toMatchObject({
            kind: 'rate-limited',
        });
        await expect(sibling.guard('gh', rateLimited('gh'))).rejects.toMatchObject({
            kind: 'rate-limited',
        });
        await expect(local.guard('vc', rateLimited('vc'))).rejects.toMatchObject({
            kind: 'rate-limited',
        });

        const started = new ExternalStatusLimiter({ now: () => now, pausePath: path });
        const work = vi.fn(() => Promise.resolve('ok'));
        await expect(started.guard('gh', work)).rejects.toMatchObject({ kind: 'rate-limited' });
        expect(work).not.toHaveBeenCalled();
        expect(started.pauseRemainingMs('vc')).toBeGreaterThan(0);
    });

    it('does not re-probe on every request when the CLI cannot report a budget', async () => {
        let now = 1_000_000;
        const probeQuota = vi.fn(() => Promise.resolve(undefined));
        const limiter = new ExternalStatusLimiter({
            now: () => now,
            pausePath: await pausePath(),
            probeQuota,
        });

        await expect(limiter.guard('gh', () => Promise.resolve('ok'))).resolves.toBe('ok');
        now += 60_000;
        await expect(limiter.guard('gh', () => Promise.resolve('ok'))).resolves.toBe('ok');
        expect(probeQuota).toHaveBeenCalledOnce();

        now += 5 * 60_000;
        await expect(limiter.guard('gh', () => Promise.resolve('ok'))).resolves.toBe('ok');
        expect(probeQuota).toHaveBeenCalledTimes(2);
    });

    it('stops polling before the account runs out, leaving points for the user own gh calls', async () => {
        const now = 1_000_000;
        const work = vi.fn(() => Promise.resolve('ok'));
        const limiter = new ExternalStatusLimiter({
            now: () => now,
            pausePath: await pausePath(),
            probeQuota: () => Promise.resolve({ remaining: 40, resetAt: now + 300_000 }),
        });

        await expect(limiter.guard('gh', work)).rejects.toMatchObject({ kind: 'rate-limited' });
        expect(work).not.toHaveBeenCalled();
    });
});

describe('parseGitHubRateLimit', () => {
    it('reads the GraphQL budget and converts its epoch-second reset', () => {
        expect(
            parseGitHubRateLimit(
                JSON.stringify({
                    resources: {
                        graphql: { limit: 5_000, remaining: 4_231, reset: 1_700_000_000 },
                    },
                }),
            ),
        ).toEqual({ remaining: 4_231, resetAt: 1_700_000_000_000 });
    });

    it('reports nothing for output without a GraphQL resource', () => {
        expect(parseGitHubRateLimit('not json')).toBeUndefined();
        expect(parseGitHubRateLimit(JSON.stringify({ resources: { core: {} } }))).toBeUndefined();
    });
});
