import type { ProjectStatusRepository } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';

import type { StatusNode } from './status-item';
import { item } from './status-item';
import { durationLabel, ignoredChecksLabel, projectStatusStateLabel } from './status-labels';
import { linkText, stateIcons, stateTones } from './status-presentation';

type PullRequest = NonNullable<ProjectStatusRepository['pullRequest']>;
type PullRequestCheck = PullRequest['checks'][number];

/**
 * More passed checks than this fold into one collapsed `N checks passed` row. A handful still reads at a glance, but a
 * pull request with a dozen green checks buried the one still running under a wall of identical rows.
 */
export const PASSED_CHECKS_COLLAPSE_THRESHOLD = 3;

/**
 * Splits a pull request's checks into the ones listed individually and the passed ones folded behind a summary row.
 * Only success folds: a failed, cancelled, running, or queued check is the reason to open the list, so it always stays
 * in view, in the provider's order.
 */
export function partitionPullRequestChecks(checks: readonly PullRequestCheck[]): {
    listed: PullRequestCheck[];
    folded: PullRequestCheck[];
} {
    const passed = checks.filter((check) => check.state === 'success');
    if (passed.length <= PASSED_CHECKS_COLLAPSE_THRESHOLD)
        return { listed: [...checks], folded: [] };
    return { listed: checks.filter((check) => check.state !== 'success'), folded: passed };
}

function checkRow(id: string, check: PullRequestCheck): StatusNode {
    const duration = durationLabel(check.durationMs);
    return item(id, check.name, {
        description: duration,
        icon: stateIcons[check.state],
        url: check.url,
        tooltip: {
            badge: {
                label: projectStatusStateLabel(check.state),
                tone: stateTones[check.state],
            },
            rows: [
                ...(duration ? [{ label: 'duration', value: duration }] : []),
                ...(check.url
                    ? [{ label: 'logs', value: linkText(check.url), url: check.url }]
                    : []),
            ],
        },
    });
}

/**
 * The pull request row's children: each check that needs a look, the passed ones folded when there are many (see
 * {@link partitionPullRequestChecks}), then the count of checks the user chose to ignore. Row ids keep each check's
 * index in the provider's list, so a check folding or unfolding as others finish does not change its identity.
 */
export function pullRequestCheckNodes(prefix: string, pullRequest: PullRequest): StatusNode[] {
    const { listed, folded } = partitionPullRequestChecks(pullRequest.checks);
    const rowFor = (check: PullRequestCheck) =>
        checkRow(`${prefix}:check:${pullRequest.checks.indexOf(check)}`, check);
    const nodes = listed.map(rowFor);
    if (folded.length > 0) {
        const label = `${folded.length} checks passed`;
        nodes.push(
            item(`${prefix}:passed-checks`, label, {
                icon: stateIcons.success,
                tooltip: { badge: { label: projectStatusStateLabel('success'), tone: 'success' } },
                children: folded.map(rowFor),
                collapsibleState: TreeItemCollapsibleState.Collapsed,
            }),
        );
    }
    if (pullRequest.hiddenCheckCount > 0) {
        nodes.push(
            item(
                `${prefix}:hidden-checks`,
                `${ignoredChecksLabel(pullRequest.hiddenCheckCount)} hidden`,
                { icon: 'eye-off' },
            ),
        );
    }
    return nodes;
}
