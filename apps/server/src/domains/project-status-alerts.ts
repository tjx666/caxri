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
    instance?: string;
    state: ProjectStatusState;
}

/**
 * Bounded because keys accumulate per repository, per pull request, and per check name across a long-running Server.
 */
const MAX_WATCHED_ITEMS = 512;

function repoKey(repo: ProjectStatusRepo): string {
    return repo.githubUrl ?? repo.rootPath;
}

/**
 * Enumerates the items a repository currently exposes as alert-worthy, keyed stably across refreshes.
 *
 * Only the current `production` and `preview` deployments are watched — `branchDeployments` is a rolling history whose
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
                item: { state: check.state },
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
        entries.push({
            key: `${scope}@${repo.branch}/deployment/${deployment.environment}`,
            item: { instance: deployment.hostname, state: deployment.state },
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
 * The first observation of an item only establishes a baseline: a Session opened onto a branch whose CI failed last
 * week must not greet the user with a notification about it. This mirrors how Agent attention notifications treat
 * startup (`agent-notifications.ts`), and it is why the tracker stores the previous state rather than a set of
 * already-notified failures.
 *
 * Keys are derived from the GitHub repository URL, so two Sessions on the same pull request converge on one
 * notification instead of one each.
 */
export class ProjectStatusAlertTracker {
    private readonly watched = new Map<string, WatchedItem>();

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
            if (!previous || item.state !== 'failure') continue;
            if (previous.state !== 'failure' || previous.instance !== item.instance)
                alerts.push(alert);
        }
        return alerts;
    }
}
