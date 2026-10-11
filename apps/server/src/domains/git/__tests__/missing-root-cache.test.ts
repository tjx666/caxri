import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRepoRootCache } from '../missing-root-cache';

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
    // Proves entries survive well past the former five minute TTL without waiting in real time.
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
    it('keeps serving the remembered failure past the former TTL while `.git` is absent', async () => {
        const cache = new MissingRepoRootCache();
        const root = await createMissingRoot('caxri-cache-no-expiry-');
        await cache.remember(root, 'The Project root is not a Git repository.');

        // A time-based expiry only re-spawned `git` for a root that was still not a repository.
        vi.advanceTimersByTime(60 * 60_000);
        await expect(cache.lookup(root, false)).resolves.toBe(
            'The Project root is not a Git repository.',
        );
    });

    it('clears the entry as soon as `.git` appears', async () => {
        const cache = new MissingRepoRootCache();
        const root = await createMissingRoot('caxri-cache-restored-');
        await cache.remember(root, 'The Project root is not a Git repository.');

        await mkdir(join(root, '.git'));

        await expect(cache.lookup(root, false)).resolves.toBeUndefined();
        await rm(join(root, '.git'), { recursive: true });
        // The restored root was evicted, not merely skipped for one lookup.
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
});
