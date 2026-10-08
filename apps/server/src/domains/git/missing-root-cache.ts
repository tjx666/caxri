import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * How long a Project root is remembered as structurally not a repository. Matches `SUMMARY_FAILURE_CACHE_TTL_MS` in
 * `project-status.ts` so both polling paths stop re-deriving the same failed Project on the same cadence. It must
 * outlast the background poll interval, or every poll lands after expiry and spawns `git` again: production (#1184) saw
 * a non-repository root re-probed every ~71s against the former 30s. It is only a backstop:
 * {@link MissingRepoRootCache.lookup} re-probes `.git` on every hit, so a restored repository clears the entry
 * immediately rather than waiting for expiry.
 */
const MISSING_REPO_ROOT_TTL_MS = 5 * 60_000;

interface CachedFailure {
    error: string;
    expiresAt: number;
}

/**
 * True when `projectRoot` has no `.git` entry, which is the structural half of a discovery failure. A Session's root
 * only passes discovery when the topology reports it as a repository root, and an ordinary repository root carries
 * `.git` directly: a directory for a normal clone, a file for a linked worktree or submodule. A subdirectory of a
 * repository fails discovery for the same reason and is equally not recoverable by retrying.
 *
 * A bare repository is the one shape that has no `.git` and is still a valid worktree root to `git`. It also fails
 * Caxri discovery, because `git status` cannot run without a work tree, and suppressing its retries is the desired
 * outcome, so the probe reaches the right answer there for a reason this rule does not name.
 */
export async function isMissingRepoRoot(projectRoot: string): Promise<boolean> {
    try {
        await lstat(resolve(projectRoot, '.git'));
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
}

/**
 * Suppresses rediscovery for Project roots that have no `.git` entry at all. Both polling sources (the sidebar and the
 * per-Session refresh) otherwise spawn `git` twice per tick forever, because nothing in the failure path ever stops
 * being retried and no event announces that the directory came back.
 *
 * This is a narrow exception to the rule in `status.ts` that a failed production must not pin the store entry. That
 * rule protects transient failures (a Git index being written, a briefly locked file) where an immediate retry is the
 * correct response, and it is preserved here unchanged: a root that still has `.git` is never remembered, including one
 * that currently fails only the approved-root check. A root with no `.git` cannot become a repository through a retry.
 *
 * Entries are keyed by canonical root path rather than Session, because a failing summary drops the Session's
 * generation and the next call allocates a new one, and therefore a new single-flight key. That churn is exactly why
 * nothing deduplicated this before.
 *
 * The cached failure message is the one the failing summary actually produced, never a message this module composes.
 * `GitSummary.error` is a public Extension API field whose wording extensions match against, so a replayed failure has
 * to be indistinguishable from the failure it stands in for.
 */
export class MissingRepoRootCache {
    private readonly entries = new Map<string, CachedFailure>();

    /**
     * The failure message to replay for `projectRoot`, or `undefined` when discovery should run. A hit re-probes
     * `.git`, so `git init`, a restored directory, or a re-added Project clears the entry on the very next request;
     * `isForced` is the user's explicit refresh and always clears it.
     */
    async lookup(projectRoot: string, isForced: boolean): Promise<string | undefined> {
        const entry = this.entries.get(projectRoot);
        if (entry === undefined) return undefined;
        if (isForced || entry.expiresAt <= Date.now() || !(await isMissingRepoRoot(projectRoot))) {
            this.entries.delete(projectRoot);
            return undefined;
        }
        return entry.error;
    }

    /**
     * Remembers `error` for `projectRoot` when its discovery failure is structural. Expired entries are pruned on the
     * way in, so the map stays bounded by the roots that failed within one TTL window.
     */
    async remember(projectRoot: string, error: string): Promise<void> {
        if (!(await isMissingRepoRoot(projectRoot))) return;
        const now = Date.now();
        for (const [root, entry] of this.entries)
            if (entry.expiresAt <= now) this.entries.delete(root);
        this.entries.set(projectRoot, { error, expiresAt: now + MISSING_REPO_ROOT_TTL_MS });
    }
}
