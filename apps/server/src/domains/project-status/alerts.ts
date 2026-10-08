import type {
    ProjectStatusRepository as ProjectStatusRepo,
    ProjectStatusState,
    ProjectStatusSummary,
} from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';

/**
 * One delivery failure worth interrupting the user for, in the identity-only shape the `projectStatus.alert` event
 * carries.
 */
export interface ProjectStatusAlert {
    kind: 'check' | 'deployment';
    repository: string;
    branch: string;
    name: string;
    url?: string;
}

/**
 * What the tracker remembers per watched item. `instance` distinguishes two different attempts that share a key: a
 * fresh Vercel deployment reuses its environment slot but has a new hostname, and a second failure of a genuinely new
 * build deserves its own notification.
 */
interface WatchedItem {
    /**
     * When the provider says this attempt settled (a check's `completedAt`) or started (a deployment's `createdAt`).
     * Only consulted for an item seen for the first time.
     */
    failedAt?: number;
    instance?: string;
    state: ProjectStatusState;
}

/**
 * Bounded because keys accumulate per repository, per pull request, and per check name across a long-running Server.
 */
const MAX_WATCHED_ITEMS = 512;

/**
 * How far back a failure seen for the first time may lie and still count as news. Background Sessions are polled every
 * few minutes and a rate-limited source backs off for up to five, so a build that failed between two polls is always
 * inside this window; a branch the user switches to hours after it broke is not.
 */
const FIRST_SEEN_FAILURE_WINDOW_MS = 30 * 60_000;

function repoKey(repo: ProjectStatusRepo): string {
    return repo.githubUrl ?? repo.rootPath;
}

/**
 * Enumerates the items a repository currently exposes as alert-worthy, keyed stably across refreshes.
 *
 * Only the current `production` and `preview` deployments are watched: `branchDeployments` is a rolling history whose
 * older entries are already-known outcomes, and replaying those as alerts would notify about builds the user has long
 * since moved past.
 */
function watchedItems(
    repo: ProjectStatusRepo,
): Array<{ alert: ProjectStatusAlert; item: WatchedItem; key: string }> {
    const scope = repoKey(repo);
    const entries: Array<{ alert: ProjectStatusAlert; item: WatchedItem; key: string }> = [];
    if (repo.pullRequest) {
        const pullRequest = repo.pullRequest;
        for (const check of pullRequest.checks) {
            entries.push({
                key: `${scope}#${pullRequest.number}/check/${check.name}`,
                item: { failedAt: check.completedAt, state: check.state },
                alert: {
                    kind: 'check',
                    repository: repo.name,
                    branch: repo.branch,
                    name: check.name,
                    url: check.url ?? pullRequest.url,
                },
            });
        }
    }
    for (const deployment of [repo.deployments?.production, repo.deployments?.preview]) {
        if (!deployment) continue;
        /**
         * A production deployment is keyed by its own hostname: a merged feature branch and the default branch both
         * resolve to the same production build, and with every Session watched that one failure must still notify once.
         * Each production build is then a new key, which the first-seen rule dates by `createdAt`.
         */
        const identity =
            deployment.environment === 'production'
                ? `production/${deployment.hostname}`
                : `${repo.branch}/preview`;
        entries.push({
            key: `${scope}/deployment/${identity}`,
            item: {
                failedAt: deployment.createdAt,
                instance: deployment.hostname,
                state: deployment.state,
            },
            alert: {
                kind: 'deployment',
                repository: repo.name,
                branch: repo.branch,
                name: deployment.environment,
                url: deployment.inspectorUrl ?? deployment.url,
            },
        });
    }
    return entries;
}

/**
 * Turns successive Project Status snapshots into delivery-failure alerts, emitting one per _transition_ into failure.
 *
 * An item seen before alerts when it moves into failure, or when a new attempt (another deployment hostname) fails. An
 * item seen for the first time alerts only when the provider dates the failure after this tracker started and within
 * {@link FIRST_SEEN_FAILURE_WINDOW_MS}: a new branch's preview build or a new pull request's check can fail between two
 * background polls, and treating every first observation as a silent baseline dropped exactly those. The date is what
 * still keeps a Session opened onto a branch whose CI failed last week, or a Server restart, from greeting the user
 * with old news. An undated first-seen failure stays silent for the same reason.
 *
 * Keys are derived from the GitHub repository URL, so two Sessions on the same pull request converge on one
 * notification instead of one each.
 */
export class ProjectStatusAlertTracker {
    private readonly watched = new Map<string, WatchedItem>();
    private readonly now: () => number;
    private readonly watchingSince: number;

    constructor(options: { now?: () => number } = {}) {
        this.now = options.now ?? Date.now;
        this.watchingSince = this.now();
    }

    private isRecentFailure(failedAt: number | undefined): boolean {
        if (failedAt === undefined) return false;
        return failedAt >= Math.max(this.watchingSince, this.now() - FIRST_SEEN_FAILURE_WINDOW_MS);
    }

    /**
     * Records `summary` and returns the failures that just started. Repeated observations of the same failure return
     * nothing, and a recovered item that fails again alerts a second time.
     */
    observe(summary: ProjectStatusSummary): ProjectStatusAlert[] {
        const entries = summary.repositories.flatMap((repo) => watchedItems(repo));
        const alerts: ProjectStatusAlert[] = [];
        for (const { alert, item, key } of entries) {
            const previous = this.watched.get(key);
            rememberBounded(this.watched, key, item, MAX_WATCHED_ITEMS);
            if (item.state !== 'failure') continue;
            if (previous) {
                if (previous.state !== 'failure' || previous.instance !== item.instance)
                    alerts.push(alert);
            } else if (this.isRecentFailure(item.failedAt)) alerts.push(alert);
        }
        return alerts;
    }
}
