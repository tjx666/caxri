import type { GitChangeTracker } from './change-tracker';
import type { GitMetadataWatcher } from './metadata-watcher';
import type { RepoTopology } from './topology';

/**
 * Registers every repository projected by a Session so metadata changes reach its cached summary.
 */
export function registerGitProjection(
    tracker: GitChangeTracker,
    watcher: GitMetadataWatcher | undefined,
    sessionId: string,
    projectRoot: string,
    topologies: readonly RepoTopology[],
    roots: readonly string[],
): void {
    tracker.registerSession(
        sessionId,
        projectRoot,
        topologies.map((topology) => topology.repositoryKey),
        roots,
    );
    for (const topology of topologies) {
        const primary = topology.worktrees.find((worktree) => worktree.isMain);
        if (!primary) continue;
        /**
         * Watcher registration owns its fallback and must not delay summary responses.
         */
        void watcher?.watch(
            topology.repositoryKey,
            primary.rootPath,
            topology.worktrees.map((worktree) => worktree.rootPath),
        );
    }
}
