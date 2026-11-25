import { stat } from 'node:fs/promises';

import type { ServerEvent } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';
import type { GitHubRepoSlug } from '@caxri/utils';
import { parseGitHubRemote } from '@caxri/utils';

import { parseGitRemoteHost } from './remote-host';
import { deriveRepoKey } from './repo-key';
import { sharedGitRequest } from './request-signal';

/**
 * Which repository group (canonical common Git directory) a root belongs to, or `undefined` when unknown: the Git
 * topology registry.
 */
export interface OriginRemoteTopology {
    repositoryKeyForRoot: (rootPath: string) => string | undefined;
}

async function isDirectoryPresent(rootPath: string): Promise<boolean> {
    try {
        return (await stat(rootPath)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * What a repository root's `origin` remote says, resolved once per root and kept until {@link revalidate}: the
 * commit-avatar privacy gate (`git.remoteHost`) must never re-spawn Git on every commit row render, the repository key
 * (`project.repositoryKeys`) is read for every Project on every machine, and the sidebar's pull-request sweep
 * (`githubRepository`) asks for every visible Session about every 30 seconds. Production logged ~3,900 `remote get-url`
 * spawns in 90 minutes from that sweep alone, with 146 Sessions and no lookup due. A remote changing mid-session is
 * rare, so the Git metadata watcher calls {@link revalidate} when `.git/config` moves instead of anything polling. Reads
 * local Git config only (`remote get-url`), never the network.
 */
export class OriginRemoteFacts {
    /**
     * The trimmed `origin` URL per root, `''` when the root has none or it could not be read.
     */
    private readonly remoteByRoot = new Map<string, string>();
    private readonly requests = new SingleFlight<string, string>();

    /**
     * @param originRemote Prints a root's `origin` URL, or an empty string when it has none.
     * @param emit Receives `state.changed` after {@link revalidate} moved any repository key, so Clients re-read them.
     * @param isRootPresent Whether a root's directory still exists; a filesystem `stat` by default.
     */
    constructor(
        private readonly originRemote: (rootPath: string) => Promise<string>,
        private readonly emit?: (event: ServerEvent) => void,
        private readonly isRootPresent: (rootPath: string) => Promise<boolean> = isDirectoryPresent,
    ) {}

    private async readRemote(rootPath: string): Promise<string> {
        try {
            return (await this.originRemote(rootPath)).trim();
        } catch {
            // No readable `origin`: nothing to derive.
            return '';
        }
    }

    private async remote(rootPath: string): Promise<string> {
        const cached = this.remoteByRoot.get(rootPath);
        if (cached !== undefined) return cached;
        return sharedGitRequest(() =>
            this.requests.run(rootPath, async () => {
                const remote = await this.readRemote(rootPath);
                this.remoteByRoot.set(rootPath, remote);
                return remote;
            }),
        );
    }

    /**
     * The cached roots to re-read, one list per Git read. Without `repoKey` every root is read on its own. With it,
     * only that repository's roots are read, and once for all of them: linked worktrees share the common `.git/config`,
     * so one `origin` answers the whole group (a per-worktree remote through `extensions.worktreeConfig` is not
     * supported). A root whose group is unknown is dropped so its next use reads `origin` again, rather than spawning
     * Git now. Production (v0.0.190) re-read every cached root on each `git worktree add`: ~800 roots, most of them
     * removed worktrees failing with `ENOENT`, burst every few minutes, 38,000 failed `remote get-url` in 83 minutes.
     */
    private revalidationGroups(
        repoKey: string | undefined,
        topology: OriginRemoteTopology | undefined,
    ): string[][] {
        const roots = this.remoteByRoot.keys().toArray();
        if (repoKey === undefined || !topology) return roots.map((root) => [root]);
        const members: string[] = [];
        for (const root of roots) {
            const key = topology.repositoryKeyForRoot(root);
            if (key === repoKey) members.push(root);
            else if (key === undefined) this.remoteByRoot.delete(root);
        }
        return members.length > 0 ? [members] : [];
    }

    /**
     * Reads `origin` once from the first member root still on disk and stores it for every member; a member whose
     * directory is gone leaves the cache instead of caching the failed read.
     */
    private async revalidateGroup(members: readonly string[]): Promise<boolean> {
        const isPresent = await Promise.all(members.map((root) => this.isRootPresent(root)));
        const present = members.filter((_, index) => isPresent[index]);
        for (const [index, root] of members.entries())
            if (!isPresent[index]) this.remoteByRoot.delete(root);
        const reader = present.at(0);
        if (reader === undefined) return false;
        const remote = await sharedGitRequest(() => this.readRemote(reader));
        let isChanged = false;
        for (const root of present) {
            const previous = this.remoteByRoot.get(root);
            // `clear()` may have run while the read was in flight; do not resurrect the root.
            if (previous === undefined) continue;
            this.remoteByRoot.set(root, remote);
            if (deriveRepoKey(previous) !== deriveRepoKey(remote)) isChanged = true;
        }
        return isChanged;
    }

    /**
     * The `origin` host, or `null` when there is none or it cannot be parsed.
     */
    async host(rootPath: string): Promise<string | null> {
        return parseGitRemoteHost(await this.remote(rootPath));
    }

    /**
     * The machine-independent repository key (see {@link deriveRepoKey}), or `null` when there is none.
     */
    async repositoryKey(rootPath: string): Promise<string | null> {
        return deriveRepoKey(await this.remote(rootPath));
    }

    /**
     * The GitHub owner and repository `origin` points at, or `undefined` when it is not a GitHub remote.
     */
    async githubRepository(rootPath: string): Promise<GitHubRepoSlug | undefined> {
        const remote = await this.remote(rootPath);
        return remote ? parseGitHubRemote(remote) : undefined;
    }

    /**
     * Re-reads `origin` and replaces the cached URL: for `repoKey`'s roots when given with the `topology` that maps
     * roots to it (see {@link revalidationGroups}), otherwise for every cached root.
     *
     * Emits `state.changed` when any root's repository key changed.
     */
    async revalidate(repoKey?: string, topology?: OriginRemoteTopology): Promise<void> {
        const changes = await Promise.all(
            this.revalidationGroups(repoKey, topology).map((members) =>
                this.revalidateGroup(members),
            ),
        );
        if (changes.includes(true))
            this.emit?.({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'project.repositoryKeys' },
            });
    }

    clear(): void {
        this.remoteByRoot.clear();
    }
}
