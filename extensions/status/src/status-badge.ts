import type { ProjectStatusSummary, ViewBadge } from 'caxri';

/**
 * Counts actionable leaves, never PR rollups or historical branch deployments. The latest preview/production aliases
 * can refer to the same deployment, so count their destination only once across the visible repositories.
 */
export function statusBadge(summary: ProjectStatusSummary | undefined): ViewBadge | undefined {
    if (!summary || summary.error) return undefined;
    const checks = new Set<string>();
    const deployments = new Set<string>();
    for (const repo of summary.repositories) {
        const pullRequest = repo.pullRequest;
        const pullRequestChecks = pullRequest?.checks ?? [];
        for (const check of pullRequestChecks) {
            if (check.state === 'failure')
                checks.add(`${pullRequest!.url}\0${check.name}\0${check.url ?? ''}`);
        }
        for (const deployment of [repo.deployments?.production, repo.deployments?.preview]) {
            if (deployment?.state === 'failure') deployments.add(deployment.url);
        }
    }
    const count = checks.size + deployments.size;
    if (count === 0) return undefined;
    const parts: string[] = [];
    if (checks.size > 0)
        parts.push(`${checks.size} failed ${checks.size === 1 ? 'check' : 'checks'}`);
    if (deployments.size > 0)
        parts.push(
            `${deployments.size} failed ${deployments.size === 1 ? 'deployment' : 'deployments'}`,
        );
    return { kind: 'error', count, description: parts.join(', ') };
}
