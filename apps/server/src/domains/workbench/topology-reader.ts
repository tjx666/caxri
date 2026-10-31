import { SingleFlight } from '@caxri/system';

import type { GitService, GitWorktreeTopology } from '../git';

/**
 * Workbench Root topology reads: a forced discovery shared by concurrent readers of one owning Project, and a
 * cached-first read for validating a binding that already exists.
 */
export class WorkbenchTopologyReader {
    private readonly forcedReads = new SingleFlight<string, GitWorktreeTopology>();

    constructor(private readonly git: Pick<GitService, 'worktreeTopology'>) {}

    /**
     * Observes an Agent's `git worktree add` before any watcher signal can land.
     */
    forced(ownerRoot: string): Promise<GitWorktreeTopology> {
        return this.forcedReads.run(ownerRoot, () => this.git.worktreeTopology(ownerRoot));
    }

    /**
     * `session.select` and `session.resume` await binding validation inside the request, so a forced `git worktree
     * list` there held every Session switch onto a linked worktree, and the requests queued behind it, for its whole
     * run (production: up to 1.3 s under load). A bound root is normally still listed, so the registry's
     * current-generation topology answers; the Git metadata watcher advances that generation on `worktree add/remove`,
     * and a deleted root still fails the identity check that follows. Only a root missing from the cached list forces a
     * fresh discovery before it may count as removed.
     */
    async containing(ownerRoot: string, boundRoot: string): Promise<GitWorktreeTopology> {
        const cached = await this.git.worktreeTopology(ownerRoot, { preferCached: true });
        if (cached.worktrees.some((worktree) => worktree.rootPath === boundRoot)) return cached;
        return this.forced(ownerRoot);
    }
}
