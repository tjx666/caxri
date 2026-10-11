import type { ProjectStatusRepository } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';

import type { StatusNode } from './status-item';
import { item } from './status-item';
import { durationLabel, ignoredChecksLabel, projectStatusStateLabel } from './status-labels';
import { linkText, stateIcons, stateTones } from './status-presentation';

type PullRequest = NonNullable<ProjectStatusRepository['pullRequest']>;
type PullRequestCheck = PullRequest['checks'][number];

/**
 * More checks of one settled kind than this fold into one collapsed summary row. A handful still reads at a glance, but
 * a pull request with a dozen green or still-running checks buried the one that failed under a wall of identical rows
 * and pushed everything below out of a narrow sidebar.
 */
export const CHECKS_COLLAPSE_THRESHOLD = 3;

interface CheckFold {
    /**
     * Stable row id suffix, so a fold keeps its expansion as checks move between groups.
     */
    key: 'in-progress-checks' | 'passed-checks';
    label: (count: number) => string;
    state: PullRequestCheck['state'];
    states: ReadonlySet<PullRequestCheck['state']>;
}

/**
 * Kinds of check that fold when there are many, in display order. A failed, cancelled, neutral, or unknown check is the
 * reason to open the list, so it never folds.
 */
const checkFolds: readonly CheckFold[] = [
    {
        key: 'in-progress-checks',
        label: (count) => `${count} checks in progress`,
        state: 'pending',
        states: new Set(['pending', 'queued']),
    },
    {
        key: 'passed-checks',
        label: (count) => `${count} checks passed`,
        state: 'success',
        states: new Set(['success']),
    },
];

/**
 * Splits a pull request's checks into the ones listed individually and the groups folded behind a summary row (see
 * {@link checkFolds}). A group folds only past {@link CHECKS_COLLAPSE_THRESHOLD}; listed checks keep the provider's
 * order.
 */
export function partitionPullRequestChecks(checks: readonly PullRequestCheck[]): {
    listed: PullRequestCheck[];
    folded: Array<{ fold: CheckFold; checks: PullRequestCheck[] }>;
} {
    const folded = checkFolds.flatMap((fold) => {
        const members = checks.filter((check) => fold.states.has(check.state));
        return members.length > CHECKS_COLLAPSE_THRESHOLD ? [{ fold, checks: members }] : [];
    });
    const isFolded = (check: PullRequestCheck) =>
        folded.some(({ fold }) => fold.states.has(check.state));
    return { listed: checks.filter((check) => !isFolded(check)), folded };
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
 * The pull request row's children: each check that needs a look, running and passed ones folded when there are many
 * (see {@link partitionPullRequestChecks}), then the count of checks the user chose to ignore. Row ids keep each check's
 * index in the provider's list, so a check folding or unfolding as others finish does not change its identity.
 */
export function pullRequestCheckNodes(prefix: string, pullRequest: PullRequest): StatusNode[] {
    const { listed, folded } = partitionPullRequestChecks(pullRequest.checks);
    const rowFor = (check: PullRequestCheck) =>
        checkRow(`${prefix}:check:${pullRequest.checks.indexOf(check)}`, check);
    const nodes = listed.map(rowFor);
    for (const { fold, checks } of folded)
        nodes.push(
            item(`${prefix}:${fold.key}`, fold.label(checks.length), {
                icon: stateIcons[fold.state],
                tooltip: {
                    badge: {
                        label: projectStatusStateLabel(fold.state),
                        tone: stateTones[fold.state],
                    },
                },
                children: checks.map(rowFor),
                collapsibleState: TreeItemCollapsibleState.Collapsed,
            }),
        );
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
