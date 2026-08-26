import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RepoTopologyRegistry } from '../topology';

function worktreeListOutput(roots: string[]): string {
    return roots.map((root) => `worktree ${root}\0branch refs/heads/main\0\0`).join('');
}

describe('RepoTopologyRegistry', () => {
    let base: string;
    let primaryRoot: string;
    let linkedRoot: string;
    let commonDirectory: string;

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'caxri-topology-'));
        primaryRoot = join(base, 'primary');
        linkedRoot = join(base, 'linked');
        commonDirectory = join(primaryRoot, '.git');
        await mkdir(commonDirectory, { recursive: true });
        await mkdir(linkedRoot, { recursive: true });
    });

    afterEach(async () => {
        await rm(base, { force: true, recursive: true });
    });

    function createRegistry(roots: () => string[]) {
        let calls = 0;
        const registry = new RepoTopologyRegistry({
            git: (_cwd, arguments_) => {
                calls += 1;
                if (arguments_.includes('--git-common-dir'))
                    return Promise.resolve(`${commonDirectory}\n`);
                return Promise.resolve(worktreeListOutput(roots()));
            },
        });
        return { calls: () => calls, registry };
    }

    it('serves repeated lookups from cache without spawning Git', async () => {
        const { calls, registry } = createRegistry(() => [primaryRoot, linkedRoot]);
        const first = await registry.topology(primaryRoot);
        expect(first.worktrees.map((worktree) => worktree.rootPath)).toEqual(
            expect.arrayContaining([expect.stringContaining('primary')]),
        );
        expect(first.worktrees).toHaveLength(2);
        const spawnsAfterFirst = calls();
        expect(spawnsAfterFirst).toBe(2);
        const second = await registry.topology(primaryRoot);
        expect(second).toBe(first);
        expect(calls()).toBe(spawnsAfterFirst);
    });

    it('joins the cached topology when looked up from a sibling linked root', async () => {
        const { calls, registry } = createRegistry(() => [primaryRoot, linkedRoot]);
        const first = await registry.topology(primaryRoot);
        const fromSibling = await registry.topology(linkedRoot);
        expect(fromSibling).toBe(first);
        expect(calls()).toBe(2);
    });

    it('rediscovers after invalidate advances the generation', async () => {
        let roots = [primaryRoot];
        const { calls, registry } = createRegistry(() => roots);
        const first = await registry.topology(primaryRoot);
        expect(first.worktrees).toHaveLength(1);
        expect(registry.isFresh(first.worktrees[0].rootPath)).toBe(true);
        roots = [primaryRoot, linkedRoot];
        const generation = registry.invalidate(first.repositoryKey);
        expect(registry.isFresh(first.worktrees[0].rootPath)).toBe(false);
        const second = await registry.topology(primaryRoot);
        expect(second.generation).toBe(generation);
        expect(second.worktrees).toHaveLength(2);
        expect(calls()).toBe(4);
    });

    it('removes stale root indexes when a refreshed topology loses a worktree', async () => {
        let roots = [primaryRoot, linkedRoot];
        const { calls, registry } = createRegistry(() => roots);
        const first = await registry.topology(primaryRoot);
        const linked = first.worktrees.find((worktree) => worktree.rootPath.endsWith('/linked'))!;

        roots = [primaryRoot];
        registry.invalidate(first.repositoryKey);
        await registry.topology(primaryRoot);

        expect(registry.repositoryKeyForRoot(linked.rootPath)).toBeUndefined();
        expect(registry.isFresh(linked.rootPath)).toBe(false);
        await registry.topology(linked.rootPath);
        expect(calls()).toBe(6);
    });

    it('always reloads under force', async () => {
        const { calls, registry } = createRegistry(() => [primaryRoot]);
        await registry.topology(primaryRoot);
        await registry.topology(primaryRoot, { force: true });
        expect(calls()).toBe(4);
    });

    it('drops missing or non-directory worktree entries from discovery', async () => {
        const missingRoot = join(base, 'missing');
        const { registry } = createRegistry(() => [primaryRoot, missingRoot]);
        const topology = await registry.topology(primaryRoot);
        expect(topology.worktrees).toHaveLength(1);
    });

    it('exposes repositoryKeyForRoot for every discovered worktree', async () => {
        const { registry } = createRegistry(() => [primaryRoot, linkedRoot]);
        const topology = await registry.topology(primaryRoot);
        for (const worktree of topology.worktrees)
            expect(registry.repositoryKeyForRoot(worktree.rootPath)).toBe(topology.repositoryKey);
        registry.clear();
        expect(registry.repositoryKeyForRoot(topology.worktrees[0].rootPath)).toBeUndefined();
    });
});
