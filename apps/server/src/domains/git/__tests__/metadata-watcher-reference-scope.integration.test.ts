import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StructuredLogger } from '@caxri/system';
import type parcelWatcher from '@parcel/watcher';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitMetadataWatcher } from '../metadata-watcher';

/**
 * Builds a commonDir whose primary worktree is on `main` and whose linked worktrees each sit on their own branch, the
 * shape every Caxri task worktree produces. Dozens of them share one `refs/` tree, which is why a ref write used to fan
 * a refresh out to all of them.
 */
async function createRepoGroup(linked: Readonly<Record<string, string>>) {
    const container = await mkdtemp(join(tmpdir(), 'caxri-ref-scope-'));
    const repoKey = join(container, 'primary', '.git');
    await mkdir(repoKey, { recursive: true });
    await writeFile(join(repoKey, 'HEAD'), 'ref: refs/heads/main\n');
    await Promise.all(
        Object.entries(linked).map(async ([name, branch]) => {
            const gitDirectory = join(repoKey, 'worktrees', name);
            await mkdir(gitDirectory, { recursive: true });
            await Promise.all([
                writeFile(join(gitDirectory, 'HEAD'), `ref: refs/heads/${branch}\n`),
                writeFile(join(gitDirectory, 'gitdir'), `${join(container, name, '.git')}\n`),
            ]);
        }),
    );
    return {
        container,
        repoKey,
        primaryRoot: join(container, 'primary'),
        rootOf: (name: string) => join(container, name),
    };
}

const containers: string[] = [];

afterEach(async () => {
    const pending = [...containers];
    containers.length = 0;
    await Promise.allSettled(pending.map((path) => rm(path, { recursive: true })));
});

describe('GitMetadataWatcher shared ref scope', () => {
    it('refreshes only the worktrees checked out on the branch whose ref moved', async () => {
        const group = await createRepoGroup({ 'feature-a': 'feature/a', 'feature-b': 'feature/b' });
        containers.push(group.container);
        let callback: parcelWatcher.SubscribeCallback | undefined;
        const subscribe: typeof parcelWatcher.subscribe = (_root, listener) => {
            callback = listener;
            return Promise.resolve({ unsubscribe: () => Promise.resolve() });
        };
        const onStatusChanged = vi.fn();
        const watcher = new GitMetadataWatcher({
            logger: { recordMetric: vi.fn(), write: vi.fn() } as unknown as StructuredLogger,
            onStatusChanged,
            onTopologyChanged: vi.fn(),
            subscribe,
        });
        try {
            await watcher.watch(group.repoKey, group.primaryRoot, [group.primaryRoot]);

            callback?.(null, [
                { type: 'update', path: join(group.repoKey, 'refs', 'heads', 'feature', 'a') },
            ]);
            await vi.waitFor(() =>
                expect(onStatusChanged).toHaveBeenCalledWith(group.repoKey, [
                    group.rootOf('feature-a'),
                ]),
            );

            // A fetch lands on the remote ref; the worktree tracking that branch is the one whose ahead/behind moved.
            onStatusChanged.mockClear();
            callback?.(null, [
                { type: 'update', path: join(group.repoKey, 'refs', 'remotes', 'origin', 'main') },
            ]);
            await vi.waitFor(() =>
                expect(onStatusChanged).toHaveBeenCalledWith(group.repoKey, [group.primaryRoot]),
            );

            // A tag carries no branch to attribute, and `packed-refs` could have moved anything: both stay broad.
            onStatusChanged.mockClear();
            callback?.(null, [
                { type: 'update', path: join(group.repoKey, 'refs', 'tags', 'v1.0.0') },
            ]);
            await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalledOnce());
            expect(onStatusChanged.mock.calls[0][1]).toEqual(
                expect.arrayContaining([
                    group.primaryRoot,
                    group.rootOf('feature-a'),
                    group.rootOf('feature-b'),
                ]),
            );
        } finally {
            await watcher.close();
        }
    });
});
