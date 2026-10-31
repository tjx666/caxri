import type { ProjectStatusSummary, ViewBadge } from 'caxri';
import { l10n } from 'caxri';

import { unresolvedCommentsLabel } from './status-labels';

/**
 * Counts actionable leaves, never PR rollups or historical branch deployments. The latest preview/production aliases
 * can refer to the same deployment, so count their destination only once across the visible repositories. Unresolved
 * review threads are actionable too, but they are feedback rather than breakage: alone they raise a count badge, and
 * beside a failure they only join the error badge's description.
 */
export function statusBadge(summary: ProjectStatusSummary | undefined): ViewBadge | undefined {
    if (!summary || summary.error) return undefined;
    const checks = new Set<string>();
    const deployments = new Set<string>();
    const reviewThreads = new Set<string>();
    for (const repo of summary.repositories) {
        const pullRequest = repo.pullRequest;
        const pullRequestChecks = pullRequest?.checks ?? [];
        for (const check of pullRequestChecks) {
            if (check.state === 'failure')
                checks.add(`${pullRequest!.url}\0${check.name}\0${check.url ?? ''}`);
        }
        const threads = pullRequest?.unresolvedReviewThreads ?? [];
        for (const thread of threads) reviewThreads.add(thread.url);
        for (const deployment of [repo.deployments?.production, repo.deployments?.preview]) {
            if (deployment?.state === 'failure') deployments.add(deployment.url);
        }
    }
    const count = checks.size + deployments.size;
    if (count === 0) {
        if (reviewThreads.size === 0) return undefined;
        return {
            kind: 'count',
            count: reviewThreads.size,
            description: unresolvedCommentsLabel(reviewThreads.size),
        };
    }
    const parts: string[] = [];
    if (checks.size > 0)
        parts.push(
            checks.size === 1
                ? l10n.t('{count} failed check', { count: checks.size })
                : l10n.t('{count} failed checks', { count: checks.size }),
        );
    if (deployments.size > 0)
        parts.push(
            deployments.size === 1
                ? l10n.t('{count} failed deployment', { count: deployments.size })
                : l10n.t('{count} failed deployments', { count: deployments.size }),
        );
    if (reviewThreads.size > 0) parts.push(unresolvedCommentsLabel(reviewThreads.size));
    // A severity badge carries no tally: the Workbench draws its glyph, so the numbers travel in the description,
    // which reaches the container tab's tooltip and accessible description.
    return { kind: 'error', description: parts.join(l10n.t(', ')) };
}
