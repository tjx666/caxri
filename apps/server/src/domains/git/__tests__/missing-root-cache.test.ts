import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRepoRootCache } from '../missing-root-cache';

const MISSING_REPO_ROOT_TTL_MS = 30_000;

const temporaryDirectories: string[] = [];

/**
 * A root that exists but carries no `.git`, which is the only shape the cache remembers.
 */
async function createMissingRoot(name: string): Promise<string> {
    const container = await mkdtemp(join(tmpdir(), name));
    temporaryDirectories.push(container);
    const root = join(container, 'project');
    await mkdir(root);
    return root;
}

beforeEach(() => {
    // The TTL is the whole subject here, and real time cannot reach 30s inside a unit test.
    vi.useFakeTimers();
});

afterEach(async () => {
    vi.useRealTimers();
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('MissingRepoRootCache', () => {
    it('serves the remembered failure until the TTL elapses', async () => {
        const cache = new MissingRepoRootCache();
        const root = await createMissingRoot('caxri-cache-ttl-');
        await cache.remember(root, 'The Project root is not a Git repository.');

        await expect(cache.lookup(root, false)).resolves.toBe(
            'The Project root is not a Git repository.',
        );

        vi.advanceTimersByTime(MISSING_REPO_ROOT_TTL_MS - 1);
        await expect(cache.lookup(root, false)).resolves.toBe(
            'The Project root is not a Git repository.',
        );

        vi.advanceTimersByTime(1);
        await expect(cache.lookup(root, false)).resolves.toBeUndefined();
        // The expired entry is dropped, not merely reported as expired.
        vi.setSystemTime(0);
        await expect(cache.lookup(root, false)).resolves.toBeUndefined();
    });

    it('forgets a root whose failure is not structural', async () => {
        const cache = new MissingRepoRootCache();
        const container = await mkdtemp(join(tmpdir(), 'caxri-cache-nonstructural-'));
        temporaryDirectories.push(container);
        await mkdir(join(container, '.git'));

        await cache.remember(container, 'The Git operation failed. Open Logs for details.');

        await expect(cache.lookup(container, false)).resolves.toBeUndefined();
    });

    it('clears an entry for an explicit refresh', async () => {
        const cache = new MissingRepoRootCache();
        const root = await createMissingRoot('caxri-cache-forced-');
        await cache.remember(root, 'The Project root is not a Git repository.');

        await expect(cache.lookup(root, true)).resolves.toBeUndefined();
        // A forced miss must evict rather than pass through, or the next unforced poll would resume the cached answer.
        await expect(cache.lookup(root, false)).resolves.toBeUndefined();
    });

    it('prunes expired entries for other roots on the next insert', async () => {
        const cache = new MissingRepoRootCache();
        const stale = await createMissingRoot('caxri-cache-stale-');
        const fresh = await createMissingRoot('caxri-cache-fresh-');
        await cache.remember(stale, 'The Project root is not a Git repository.');

        vi.advanceTimersByTime(MISSING_REPO_ROOT_TTL_MS);
        await cache.remember(fresh, 'The Project root is not a Git repository.');

        // Rewinding proves the stale entry was removed rather than merely being past its expiry on read.
        vi.setSystemTime(0);
        await expect(cache.lookup(stale, false)).resolves.toBeUndefined();
        await expect(cache.lookup(fresh, false)).resolves.toBe(
            'The Project root is not a Git repository.',
        );
    });
});
