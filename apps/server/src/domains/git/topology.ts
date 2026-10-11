import { lstat, realpath } from 'node:fs/promises';

import { mapWithConcurrency } from '@caxri/system';

import { SingleFlight } from '../single-flight';
import { parseWorktreeEntries } from './repo';
import { sharedGitRequest } from './request-signal';

const MAX_TOPOLOGIES = 256;

export interface GitWorktreeTopology {
    repositoryKey: string;
    worktrees: Array<{ branch: string; rootPath: string; isMain?: boolean }>;
}

interface RepoWorktree {
    branch: string;
    rootPath: string;
    isMain: boolean;
}

/**
 * Canonical linked-worktree topology of one repository group. `repositoryKey` is the realpath of the shared common Git
 * directory, so every linked worktree of the same repository resolves to the same key regardless of which root the
 * lookup started from.
 */
export interface RepoTopology {
    generation: number;
    repositoryKey: string;
    worktrees: RepoWorktree[];
}

interface TopologyRegistryOptions {
    git: (cwd: string, arguments_: string[]) => Promise<string>;
}

interface TopologyEntry {
    generation: number;
    topology: RepoTopology;
}

/**
 * The single owner of Git worktree discovery. `git.summary`, Workbench Root candidates, and the Git metadata watcher
 * all read this registry instead of running their own `worktree list` / `rev-parse` chains, so one cold discovery
 * serves every consumer until the repository's topology generation advances (external `worktree add/remove`, `config`
 * change, or an explicit refresh).
 *
 * Discovery never implies authorization: unauthorized worktrees are visible here for Workbench candidate flows, but Git
 * SecondarySidebar consumers must still filter against approved Project roots.
 */
export class RepoTopologyRegistry {
    private readonly entries = new Map<string, TopologyEntry>();
    private readonly generations = new Map<string, number>();
    private readonly loads = new SingleFlight<string, RepoTopology>();
    /**
     * Canonical worktree root → repositoryKey, so a cached lookup from any linked worktree joins the topology
     * discovered from a sibling root without spawning Git.
     */
    private readonly rootIndex = new Map<string, string>();

    constructor(private readonly options: TopologyRegistryOptions) {}

    private currentGeneration(repoKey: string): number {
        return this.generations.get(repoKey) ?? 0;
    }

    private remember(topology: RepoTopology): void {
        this.entries.delete(topology.repositoryKey);
        this.entries.set(topology.repositoryKey, {
            generation: topology.generation,
            topology,
        });
        const currentRoots = new Set(topology.worktrees.map((worktree) => worktree.rootPath));
        for (const [rootPath, repoKey] of this.rootIndex)
            if (repoKey === topology.repositoryKey && !currentRoots.has(rootPath))
                this.rootIndex.delete(rootPath);
        for (const worktree of topology.worktrees)
            this.rootIndex.set(worktree.rootPath, topology.repositoryKey);
        while (this.entries.size > MAX_TOPOLOGIES) {
            const oldest = this.entries.keys().next().value;
            if (!oldest) break;
            this.evict(oldest);
        }
    }

    private evict(repoKey: string): void {
        this.entries.delete(repoKey);
        this.generations.delete(repoKey);
        for (const [rootPath, key] of this.rootIndex)
            if (key === repoKey) this.rootIndex.delete(rootPath);
    }

    private async load(root: string, git: TopologyRegistryOptions['git']): Promise<RepoTopology> {
        /**
         * A failed probe must still drain its sibling command. Otherwise summary returns before that command logs its
         * failure, letting shutdown flush the logger and remove its directory while a producer is still running.
         */
        const [commonDirectoryOutput, worktreeOutput] = await mapWithConcurrency(
            [
                ['rev-parse', '--path-format=absolute', '--git-common-dir'],
                ['worktree', 'list', '--porcelain', '-z'],
            ],
            2,
            (arguments_) => git(root, arguments_),
        );
        const repoKey = await realpath(commonDirectoryOutput.trim());
        const worktrees = (
            await Promise.all(
                parseWorktreeEntries(worktreeOutput).map(async (entry, index) => {
                    try {
                        /**
                         * Absorbed submodules report their gitDir as the primary worktree in `worktree list`. Resolve
                         * core.worktree through Git so metadata invalidation targets the actual checkout.
                         */
                        const listedRoot = await realpath(entry.rootPath);
                        const rootPath =
                            listedRoot === repoKey
                                ? await realpath(
                                      (await git(repoKey, ['rev-parse', '--show-toplevel'])).trim(),
                                  )
                                : listedRoot;
                        const stats = await lstat(rootPath);
                        return stats.isDirectory() && !stats.isSymbolicLink()
                            ? [{ branch: entry.branch, rootPath, isMain: index === 0 }]
                            : [];
                    } catch {
                        return [];
                    }
                }),
            )
        ).flat();
        const topology: RepoTopology = {
            generation: this.currentGeneration(repoKey),
            repositoryKey: repoKey,
            worktrees,
        };
        this.remember(topology);
        return topology;
    }

    /**
     * Returns the topology for the repository containing `root`. A cached topology at the current generation returns
     * without spawning Git; `force` always reloads (Workbench flows must observe a `git worktree add` before any
     * watcher signal can land).
     */
    async topology(
        root: string,
        options: { force?: boolean; git?: TopologyRegistryOptions['git'] } = {},
    ): Promise<RepoTopology> {
        const canonical = await realpath(root);
        if (!options.force) {
            const repoKey = this.rootIndex.get(canonical);
            const entry = repoKey ? this.entries.get(repoKey) : undefined;
            if (repoKey && entry && entry.generation === this.currentGeneration(repoKey)) {
                // Refresh LRU recency without mutating the cached value.
                this.entries.delete(repoKey);
                this.entries.set(repoKey, entry);
                return entry.topology;
            }
        }
        return sharedGitRequest(() =>
            this.loads.run(canonical, () => this.load(canonical, options.git ?? this.options.git)),
        );
    }

    /**
     * Reports whether a lookup for `root` would be served from cache at the current generation.
     */
    isFresh(root: string): boolean {
        const repoKey = this.rootIndex.get(root);
        const entry = repoKey ? this.entries.get(repoKey) : undefined;
        return Boolean(repoKey && entry && entry.generation === this.currentGeneration(repoKey));
    }

    repositoryKeyForRoot(rootPath: string): string | undefined {
        return this.rootIndex.get(rootPath);
    }

    /**
     * Advances the topology generation so the next read rediscovers worktrees. Returns the new generation for change
     * receipts.
     */
    invalidate(repoKey: string): number {
        const next = this.currentGeneration(repoKey) + 1;
        this.generations.set(repoKey, next);
        return next;
    }

    /**
     * Releases every retained topology, e.g. when Project authorization changes invalidate the cached view of which
     * roots exist.
     */
    clear(): void {
        this.entries.clear();
        this.generations.clear();
        this.rootIndex.clear();
    }
}
