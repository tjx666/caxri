import type { ProjectStatusSummary, SessionPullRequest } from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';

/**
 * One pull request a Session's Status snapshot just saw turn merged.
 */
export interface ProjectStatusMerge {
    mergedAt?: number;
    url: string;
}

/**
 * Bounded because keys accumulate per Session and pull request across a long-running Server.
 */
const MAX_WATCHED_PULL_REQUESTS = 512;

/**
 * How far back a merge seen for the first time may lie and still count as news; the same window the delivery-failure
 * alerts use, for the same reason (background Sessions are polled minutes apart).
 */
const FIRST_SEEN_MERGE_WINDOW_MS = 30 * 60_000;

/**
 * Turns successive Project Status snapshots into merges worth announcing to the Session's Agent.
 *
 * The sidebar's pull request sweep follows one pull request per Session, so a Session that delivers through several
 * repositories (a submodule, a nested or linked repository) never heard about the others merging. The Status panel
 * already reads every repository's pull request, so this tracker watches each of them per Session.
 *
 * A pull request counts once it was seen open and is now merged. One seen for the first time already merged counts only
 * when GitHub dates the merge after this tracker started and within {@link FIRST_SEEN_MERGE_WINDOW_MS}, so starting
 * Server Core or opening an old Session never announces old merges. Deduplication against the sidebar sweep and the
 * merge button is the merge notice's job, keyed by Session and pull request URL.
 */
export class ProjectStatusMergeTracker {
    private readonly watched = new Map<string, SessionPullRequest['state']>();
    private readonly now: () => number;
    private readonly watchingSince: number;

    constructor(options: { now?: () => number } = {}) {
        this.now = options.now ?? Date.now;
        this.watchingSince = this.now();
    }

    private isRecentMerge(mergedAt: number | undefined): boolean {
        if (mergedAt === undefined) return false;
        return mergedAt >= Math.max(this.watchingSince, this.now() - FIRST_SEEN_MERGE_WINDOW_MS);
    }

    /**
     * Records `summary` for `sessionId` and returns the pull requests that just turned merged.
     */
    observe(sessionId: string, summary: ProjectStatusSummary): ProjectStatusMerge[] {
        const merges: ProjectStatusMerge[] = [];
        for (const repo of summary.repositories) {
            const pullRequest = repo.pullRequest;
            if (!pullRequest?.lifecycle) continue;
            const key = `${sessionId}\n${pullRequest.url}`;
            const previous = this.watched.get(key);
            rememberBounded(this.watched, key, pullRequest.lifecycle, MAX_WATCHED_PULL_REQUESTS);
            if (previous === 'merged' || pullRequest.lifecycle !== 'merged') continue;
            const isTransition = previous === 'open' || previous === 'draft';
            const isFreshFirstSighting = !previous && this.isRecentMerge(pullRequest.mergedAt);
            if (!isTransition && !isFreshFirstSighting) continue;
            merges.push({
                url: pullRequest.url,
                ...(pullRequest.mergedAt !== undefined && { mergedAt: pullRequest.mergedAt }),
            });
        }
        return merges;
    }
}
